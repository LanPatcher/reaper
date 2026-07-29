import Capacitor
import Foundation
import UIKit
import UserNotifications

/**
 * Local notifications, raised by the app about itself.
 *
 * There is no server in this app, so there is nothing that could send a push —
 * Apple's push service delivers what a provider sends it, and a provider would
 * be a machine that knows who is messaging whom. The app raises its own
 * instead, which it can do because the keepalive audio session keeps it running
 * in the background with its sockets open.
 *
 * ## The delegate, and why it is set here
 *
 * `UNUserNotificationCenter` will not tell anybody a notification was tapped
 * unless something is its delegate before the tap is delivered — and the tap
 * that *launches* the app is delivered during launch, long before the WebView
 * has loaded, let alone subscribed. So the delegate is installed in `load()`,
 * which Capacitor calls while the plugin is being built, and taps that arrive
 * before JavaScript is listening are held rather than dropped.
 *
 * That holding is not a nicety. Tapping a notification to open the app *is* the
 * normal way one is used, and it is precisely the case where nothing is
 * subscribed yet.
 */
@objc(NotifyPlugin)
public class NotifyPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "NotifyPlugin"
  public let jsName = "Notify"

  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "permission", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "badge", returnType: CAPPluginReturnPromise),
  ]

  private let taps = TapRelay()

  override public func load() {
    taps.deliver = { [weak self] data in
      self?.notifyListeners("tapped", data: ["data": data])
    }

    UNUserNotificationCenter.current().delegate = taps
  }

  /**
   * Ask, once.
   *
   * `.alert, .sound, .badge` and deliberately not `.provisional`. Provisional
   * authorisation delivers quietly to the notification centre without ever
   * prompting, which sounds generous and is wrong here: somebody who has just
   * linked a phone in order to be reachable on it needs the banner, and finding
   * out days later that messages were being filed silently is worse than a
   * prompt.
   */
  @objc func request(_ call: CAPPluginCall) {
    UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .sound, .badge]
    ) { [weak self] granted, _ in
      // The result of `requestAuthorization` is only the answer to this
      // prompt. Reading the settings back is what reports the real state,
      // including a refusal made long ago that never showed a prompt at all.
      self?.settle(call, fallbackGranted: granted)
    }
  }

  @objc func permission(_ call: CAPPluginCall) {
    settle(call, fallbackGranted: false)
  }

  private func settle(_ call: CAPPluginCall, fallbackGranted: Bool) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let status = settings.authorizationStatus

      call.resolve([
        "granted": status == .authorized || status == .provisional || status == .ephemeral
          ? true
          : (status == .notDetermined ? fallbackGranted : false),
        "asked": status != .notDetermined,
      ])
    }
  }

  /**
   * Post one immediately.
   *
   * A nil trigger means "now" rather than "on a schedule", which is what this
   * is: the message has already arrived over a socket that is already open.
   *
   * The identifier is what keeps a busy conversation to one row in the shade.
   * Reusing it replaces the notification rather than stacking another beneath
   * it — forty banners from one person is not forty times as informative as
   * one, and on a phone it is the difference between useful and unusable.
   */
  @objc func show(_ call: CAPPluginCall) {
    guard let title = call.getString("title"), let body = call.getString("body") else {
      call.reject("title and body are required")
      return
    }

    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body

    if call.getBool("sound") ?? true {
      content.sound = .default
    }

    if let data = call.getString("data") {
      content.userInfo = ["data": data]
    }

    let request = UNNotificationRequest(
      identifier: call.getString("id") ?? UUID().uuidString,
      content: content,
      trigger: nil
    )

    UNUserNotificationCenter.current().add(request) { error in
      if let error {
        call.reject("could not post the notification: \(error.localizedDescription)")
        return
      }
      call.resolve()
    }
  }

  @objc func clear(_ call: CAPPluginCall) {
    UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    call.resolve()
  }

  @objc func badge(_ call: CAPPluginCall) {
    let count = max(0, call.getInt("count") ?? 0)

    DispatchQueue.main.async {
      if #available(iOS 16.0, *) {
        UNUserNotificationCenter.current().setBadgeCount(count)
      } else {
        UIApplication.shared.applicationIconBadgeNumber = count
      }
      call.resolve()
    }
  }
}

/**
 * The notification centre's delegate, and a buffer for taps nobody heard.
 *
 * Separate from the plugin rather than folded into it because the delegate is
 * held weakly nowhere — `UNUserNotificationCenter.delegate` is an unowned-ish
 * reference in practice and a plugin that is deallocated while still the
 * delegate is a crash waiting for somebody to tap a banner.
 *
 * The buffer is the important part. A tap that launches the app is delivered
 * while the WebView is still loading, so the JavaScript that wants to know
 * about it does not exist yet. Dropping it means the app opens on whatever it
 * was last showing instead of on the conversation the user tapped — which
 * reads as the notification not working.
 */
final class TapRelay: NSObject, UNUserNotificationCenterDelegate {
  /// Set once the JavaScript side is listening.
  var deliver: ((String) -> Void)? {
    didSet {
      guard deliver != nil else { return }

      let waiting = held
      held = []
      for data in waiting { deliver?(data) }
    }
  }

  private var held: [String] = []

  /**
   * A notification arrived while the app was in the foreground.
   *
   * Suppressed, and that is deliberate rather than an oversight. The app only
   * posts these while it is in the background — see the JavaScript side — so
   * one arriving in the foreground is a race: backgrounded, message arrives,
   * foregrounded before the system draws it. Showing a banner over the
   * conversation the user is already reading is noise.
   */
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let data = response.notification.request.content.userInfo["data"] as? String ?? ""

    if deliver != nil {
      deliver?(data)
    } else {
      // Bounded. A tap nobody ever listens for is a leak otherwise, and after
      // a handful the user's intent is stale anyway — they are looking at the
      // app by now.
      if held.count < 8 { held.append(data) }
    }

    completionHandler()
  }
}
