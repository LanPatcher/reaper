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
 * The category depends on whether a call is in progress, and the reason it is
 * not fixed is that this session outlives every individual use of it — it is
 * installed at startup and stays installed, so a permanent claim to be a
 * recording app is a permanent claim, including while somebody is listening to
 * something else.
 *
 * At rest: `.playback` with `.mixWithOthers`. Background execution, no input,
 * and no effect on other audio on the device.
 *
 * In a call: `.playAndRecord` with `.allowBluetooth`, for as long as the call
 * lasts and no longer.
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

  /**
   * Whether a call is actually in progress.
   *
   * This exists because the session is installed once, at startup, and stays
   * installed for as long as the app is running — so whatever it claims, it
   * claims the entire time, including while somebody is listening to an
   * audiobook in another app.
   *
   * It used to claim `.playAndRecord` with `.allowBluetooth` permanently, and
   * both halves of that degraded everything else playing on the device:
   *
   *   - `.allowBluetooth` is a request for HFP, the hands-free *phone call*
   *     profile — 8 or 16 kHz, mono. Asking for it puts the headphones into
   *     that profile for every app, so music and audiobooks come out sounding
   *     like a speakerphone. The constant for "Bluetooth, but the good one" is
   *     `.allowBluetoothA2DP`, and it is a different thing entirely.
   *
   *   - `.playAndRecord` reconfigures the hardware for input as well as
   *     output, which changes the route and the rate whether or not anything
   *     is recording.
   *
   * So at rest this is `.playback`: background execution, no input, no claim
   * on the microphone and no effect on anybody else's audio. `.playAndRecord`
   * is adopted only when a call starts, which is the only time the trade is
   * worth making, and dropped again when it ends.
   */
  private var inCall = false
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

  /**
   * The category for the state the app is actually in.
   *
   * One function rather than a call site per state, because the failure this
   * fixes was two call sites disagreeing about what the session was for.
   */
  private func applyCategory() throws {
    if inCall {
      // A call needs the microphone, and HFP is correct here: it is the only
      // Bluetooth profile with an input path at all. The audio quality cost is
      // real and unavoidable, and it lasts as long as the call rather than as
      // long as the app.
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.mixWithOthers, .allowBluetooth, .defaultToSpeaker]
      )
      return
    }

    // At rest. `.playback` still earns background execution — that is what
    // keeps the connection alive with the screen locked — but it makes no
    // claim on input, so nothing else on the device is disturbed.
    //
    // `.mixWithOthers` so this never becomes the "now playing" app and never
    // pauses what somebody is already listening to.
    try session.setCategory(
      .playback,
      mode: .default,
      options: [.mixWithOthers]
    )
  }

  /**
   * Enter or leave call mode.
   *
   * Returns false if the switch failed, in which case the previous category is
   * still in force — a call with no microphone is worth reporting, and silently
   * carrying on with the wrong category is how this became hard to see.
   */
  @discardableResult
  func setInCall(_ active: Bool) -> Bool {
    if inCall == active { return true }

    let previous = inCall
    inCall = active

    do {
      try applyCategory()

      // Re-activating is what makes the route change take effect on a session
      // that is already running.
      if running { try session.setActive(true, options: []) }
      return true
    } catch {
      inCall = previous
      lastError = "audio session: \(error.localizedDescription)"
      return false
    }
  }

  func start() -> Bool {
    if running { return true }
    lastError = nil

    do {
      // Announced before activating, so the system knows what kind of app this
      // is claiming to be before it is asked to grant anything.
      try applyCategory()
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
