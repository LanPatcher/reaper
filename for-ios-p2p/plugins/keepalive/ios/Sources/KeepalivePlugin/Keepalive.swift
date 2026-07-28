import AVFoundation
import UserNotifications
import UIKit
import Foundation

/**
 * Staying alive in the background.
 *
 * ## The problem
 *
 * Reaper has no server. A message reaches this device because a peer opened a
 * socket to it, which means the app has to be running and listening — and iOS
 * suspends an app a few seconds after it leaves the foreground, closing every
 * socket it held. The usual escape hatch is a push notification, and that needs
 * APNs: a permanently online third party that sees who is messaging whom, which
 * is the exact thing this app is built to avoid.
 *
 * So the app has to keep itself running. iOS grants indefinite background
 * execution to apps playing audio, and it does not check that the audio is
 * interesting. Holding an audio session open with a buffer of silence keeps the
 * process alive and the sockets with it.
 *
 * ## Being a good citizen about it
 *
 * The category is `.playAndRecord` with `.mixWithOthers`, and each part
 * matters:
 *
 *   - `.playAndRecord` earns background execution *and* permits input.
 *     `.playback` earns the first and forbids the second, which is how voice
 *     calls came to report the microphone as unavailable. `.ambient`
 *     does not.
 *   - `.mixWithOthers` means this does not become the "now playing" app and
 *     does not stop anything else. Without it, launching Reaper would pause
 *     Spotify — silently, since our audio is silence — and the lock screen
 *     controls would start driving an app playing nothing.
 *
 * `.duckOthers` is deliberately absent: it would quieten other audio to make
 * room for ours, and ours is nothing.
 *
 * The buffer is true digital silence rather than a very quiet tone. A tone is
 * sometimes recommended on the theory that iOS discards silent buffers, which
 * has not been true for a long time, and an inaudible tone is still a tone —
 * it would show up on a spectrogram and go through anyone's hearing aid.
 *
 * ## What this does not achieve
 *
 * Worth being straight about, because the difference matters when a message
 * does not arrive:
 *
 *   - **Memory pressure still wins.** iOS terminates background apps when the
 *     foreground needs room. Audio raises the priority; it does not exempt.
 *   - **A reboot ends it.** Nothing restarts the app until it is opened.
 *   - **Force-quitting ends it**, and iOS treats that as a decision not to run.
 *   - **The App Store forbids it.** Review guideline 2.5.4 requires background
 *     audio to exist for the user's benefit. This is for sideloading, which is
 *     what it was built for.
 *
 * So reachability is "usually", not "always" — which is still the difference
 * between a chat app and a thing that only works while you look at it.
 */
final class Keepalive {
  private let session = AVAudioSession.sharedInstance()
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?

  /** Whether the session is currently being held open. */
  private(set) var running = false

  /**
   * The last failure, if there was one.
   *
   * Kept rather than only logged: the app can show "background delivery is off"
   * honestly instead of the user discovering it through messages that arrive
   * late and in a batch.
   */
  private(set) var lastError: String?

  /**
   * One second of silence, looped.
   *
   * Short buffers mean the render callback runs constantly, which costs battery
   * for nothing; very long ones make stopping sluggish. A second is the usual
   * compromise and is what other background-audio apps settle on.
   */
  private static let bufferSeconds: Double = 1.0

  func start() -> Bool {
    if running { return true }
    lastError = nil

    do {
      // Announced before activating, so the system knows what kind of app this
      // is claiming to be before it is asked to grant anything.
      // `.playAndRecord`, not `.playback`.
      //
      // `.playback` earns background execution and forbids input, and that
      // second half is what broke voice: this session is installed at startup
      // and stays installed, so by the time anything asks for a microphone the
      // category already says this app does not record. `getUserMedia` then
      // fails, and it fails as "microphone unavailable" rather than as
      // anything naming an audio session.
      //
      // `.playAndRecord` keeps the background execution and permits input. The
      // recording indicator only appears while something is actually
      // capturing, so an idle app looks no different than it did.
      //
      // `.defaultToSpeaker` because the alternative is the earpiece: without
      // it a call comes out of the receiver at the top of the phone, which
      // sounds like the volume is broken.
      try session.setCategory(
        .playAndRecord,
        mode: .default,
        options: [.mixWithOthers, .allowBluetooth, .defaultToSpeaker]
      )
      try session.setActive(true, options: [])
    } catch {
      lastError = "audio session: \(error.localizedDescription)"
      return false
    }

    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()

    // Whatever the hardware is already using. Asking for a specific rate forces
    // a resample of silence, and worse, fails outright on a device whose route
    // has changed — plugging in headphones mid-session is enough.
    let format = engine.outputNode.inputFormat(forBus: 0)

    guard format.sampleRate > 0,
          let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(format.sampleRate * Self.bufferSeconds)
          )
    else {
      lastError = "could not build a silent buffer"
      deactivate()
      return false
    }

    // A freshly allocated buffer is already zeroed, but its length is not set —
    // and a buffer of length zero plays instantly and forever completes, which
    // presents as an app that suspends anyway.
    buffer.frameLength = buffer.frameCapacity

    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: format)

    do {
      try engine.start()
    } catch {
      lastError = "audio engine: \(error.localizedDescription)"
      engine.detach(player)
      deactivate()
      return false
    }

    player.scheduleBuffer(buffer, at: nil, options: [.loops])
    player.play()

    self.engine = engine
    self.player = player
    running = true

    // Interruptions — a phone call, Siri, another app taking exclusive audio —
    // stop the engine, and nothing restarts it on its own. Without this the app
    // stays alive until the first incoming call and then quietly stops being
    // reachable for the rest of the day.
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(interrupted(_:)),
      name: AVAudioSession.interruptionNotification,
      object: session
    )

    // Likewise a route change: unplugging headphones can stop the engine, and
    // the format that was negotiated may no longer apply.
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(routeChanged(_:)),
      name: AVAudioSession.routeChangeNotification,
      object: session
    )

    return true
  }

  func stop() {
    NotificationCenter.default.removeObserver(self)

    player?.stop()
    engine?.stop()

    if let engine = engine, let player = player {
      engine.detach(player)
    }

    player = nil
    engine = nil
    running = false

    deactivate()
  }

  /**
   * Give the audio hardware back.
   *
   * `notifyOthersOnDeactivation` is what tells whatever was ducked or paused
   * that it may resume. Leaving it out is how an app becomes the reason music
   * never comes back after a call.
   */
  private func deactivate() {
    try? session.setActive(false, options: [.notifyOthersOnDeactivation])
  }

  @objc private func interrupted(_ note: Notification) {
    guard
      let info = note.userInfo,
      let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw)
    else { return }

    switch type {
    case .began:
      // Nothing to do but wait. The engine is already stopped by the system.
      break

    case .ended:
      // Only resume when told it is appropriate. Restarting audio during
      // somebody's phone call is worse than being unreachable for its duration.
      let options = (info[AVAudioSessionInterruptionOptionKey] as? UInt)
        .map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []

      if options.contains(.shouldResume) { restart() }

    @unknown default:
      break
    }
  }

  @objc private func routeChanged(_ note: Notification) {
    guard running else { return }

    // The engine survives most route changes and does not survive all of them.
    // Asking is cheaper than assuming.
    if engine?.isRunning != true { restart() }
  }

  private func restart() {
    stop()
    _ = start()
  }
}


// ---- being closed for good --------------------------------------------------

/**
 * Tell the user, once, that a closed app receives nothing.
 *
 * This app is not a client of a server that will hold messages for it. There
 * is nothing anywhere keeping a copy: a peer that cannot reach this device
 * simply keeps its events until it can, and "until it can" means the next time
 * Reaper is open. Swiping it away is therefore a much bigger act here than in
 * any other messaging app, and nothing about the gesture says so.
 *
 * A local notification is the only honest way to say it. There is no push
 * service — that would need a server holding a token and a copy of the
 * message, which is the entire arrangement this app exists without — so the
 * notice has to be scheduled by the app itself, in the moments the system
 * gives it while it is being terminated.
 *
 * Deliberately not repeated. Somebody who closes the app on purpose every day
 * does not need telling every day, so it is shown once per install unless the
 * app is reinstalled.
 */
enum ClosedNotice {
    private static let asked = "reaper.notice.asked"
    private static let shown = "reaper.notice.shown"

    /// Ask once, quietly, and only for the one notification this app sends.
    static func prepare() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: asked) else { return }
        defaults.set(true, forKey: asked)

        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound]
        ) { _, _ in
            // Refused is a perfectly reasonable answer and there is nothing to
            // do about it. The app works exactly the same; the user simply is
            // not told the one thing this would have told them.
        }
    }

    /// Watch for the app being closed.
    static func watch() {
        prepare()

        NotificationCenter.default.addObserver(
            forName: UIApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { _ in post() }
    }

    private static func post() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: shown) else { return }
        defaults.set(true, forKey: shown)

        let content = UNMutableNotificationContent()
        content.title = "Reaper is closed"
        content.body =
            "Messages will not arrive until you open it again. There is no "
            + "server holding them — they wait on the sender's device."
        content.sound = .default

        // A second's delay rather than immediately: a notification requested
        // during termination is often dropped, and the smallest trigger the
        // system accepts is what gets it delivered.
        let request = UNNotificationRequest(
            identifier: "reaper.closed",
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        )

        UNUserNotificationCenter.current().add(request)
    }
}
