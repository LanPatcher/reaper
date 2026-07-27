import Capacitor
import Foundation
import UIKit

/**
 * `Keepalive` as seen from the WebView.
 *
 * Thin on purpose: everything that decides whether the app keeps running lives
 * in `Keepalive.swift`, and this is the part that talks to JavaScript.
 *
 * The one piece of policy here is the background-task assertion around the
 * moment of leaving the foreground. Starting an audio session takes a few
 * hundred milliseconds, and if the app is suspended during them it never
 * finishes — so the app is asked to stay awake for the handful of seconds that
 * takes, by which time the audio session is the thing keeping it alive.
 */
@objc(KeepalivePlugin)
public class KeepalivePlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "KeepalivePlugin"
  public let jsName = "Keepalive"

  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
  ]

  private let keepalive = Keepalive()
  private var handoff: UIBackgroundTaskIdentifier = .invalid

  override public func load() {
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(leavingForeground),
      name: UIApplication.didEnterBackgroundNotification,
      object: nil
    )

    NotificationCenter.default.addObserver(
      self,
      selector: #selector(enteredForeground),
      name: UIApplication.willEnterForegroundNotification,
      object: nil
    )
  }

  @objc func start(_ call: CAPPluginCall) {
    let ok = keepalive.start()
    call.resolve([
      "running": ok,
      "error": keepalive.lastError as Any,
    ])
  }

  @objc func stop(_ call: CAPPluginCall) {
    keepalive.stop()
    call.resolve(["running": false])
  }

  @objc func status(_ call: CAPPluginCall) {
    call.resolve([
      "running": keepalive.running,
      "error": keepalive.lastError as Any,
    ])
  }

  /**
   * Cover the gap between backgrounding and the audio session taking hold.
   *
   * Without this the app can be suspended while the session is still being
   * set up, and the thing that was meant to prevent suspension never gets to
   * run. The assertion is released as soon as the session is up.
   */
  @objc private func leavingForeground() {
    guard keepalive.running else { return }

    endHandoff()

    handoff = UIApplication.shared.beginBackgroundTask(withName: "reaper.keepalive") {
      // The system's deadline. Ending it here is not optional — an assertion
      // that outlives its expiry gets the app killed outright.
      self.endHandoff()
    }

    // A moment is enough: by now the audio session is what keeps the process
    // alive, and holding the assertion any longer only wastes the allowance.
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
      self?.endHandoff()
    }

    notifyListeners("backgrounded", data: ["running": keepalive.running])
  }

  @objc private func enteredForeground() {
    endHandoff()

    // The session may have been torn down while away — an interruption that
    // never resumed, or the engine stopping on a route change nobody saw. The
    // app is on screen now, so recovering costs nothing and being wrong about
    // it costs every message sent in the meantime.
    if !keepalive.running {
      _ = keepalive.start()
    }

    notifyListeners("foregrounded", data: ["running": keepalive.running])
  }

  private func endHandoff() {
    guard handoff != .invalid else { return }
    UIApplication.shared.endBackgroundTask(handoff)
    handoff = .invalid
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    endHandoff()
  }
}
