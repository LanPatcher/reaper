import Capacitor
import Foundation

/**
 * `TcpSockets` as seen from the WebView.
 *
 * Sockets are addressed by id rather than handed across as objects, because
 * nothing can cross that boundary but JSON. Payloads are base64 for the same
 * reason: the bridge has no representation for bytes, and sending a JSON array
 * of numbers would roughly quadruple every frame.
 */
@objc(SocketPlugin)
public class SocketPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "SocketPlugin"
  public let jsName = "Socket"

  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "stopListening", returnType: CAPPluginReturnPromise),
  ]

  private var sockets: TcpSockets?

  override public func load() {
    sockets = TcpSockets { [weak self] id, event, payload in
      var data = payload
      data["id"] = id
      // One channel for every socket rather than one per id: listeners are not
      // free, and the transport demultiplexes by id anyway.
      self?.notifyListeners(event, data: data)
    }
  }

  @objc func connect(_ call: CAPPluginCall) {
    guard
      let id = call.getString("id"),
      let host = call.getString("host"),
      let port = call.getInt("port")
    else {
      call.reject("id, host and port are required")
      return
    }

    // 9050 is Tor's default. Passed in rather than assumed because the client
    // embedded in the app picks its own port to avoid colliding with a Tor
    // the user may already be running.
    let proxy = call.getInt("proxyPort") ?? 9050

    sockets?.connect(
      id: id,
      host: host,
      port: UInt16(port),
      proxyPort: UInt16(proxy)
    )

    // Resolves when the request has been made, not when it succeeds. The
    // outcome arrives as a `connect` or an `error` event, because a connection
    // over Tor can take twenty seconds and a promise that waits that long
    // looks like the app has hung.
    call.resolve()
  }

  @objc func send(_ call: CAPPluginCall) {
    guard
      let id = call.getString("id"),
      let base64 = call.getString("data"),
      let data = Data(base64Encoded: base64)
    else {
      call.reject("id and base64 data are required")
      return
    }

    sockets?.send(id: id, data: data)
    call.resolve()
  }

  @objc func close(_ call: CAPPluginCall) {
    guard let id = call.getString("id") else {
      call.reject("id is required")
      return
    }

    sockets?.close(id: id)
    call.resolve()
  }

  /**
   * Bind a loopback port, and resolve only once it is actually bound.
   *
   * The port is what Tor is told to forward its onion service to, so resolving
   * early with a placeholder is worse than failing: Tor is handed a target of
   * zero, refuses, and the app reports that nothing can be sent or received —
   * which describes the consequence and not the cause.
   */
  @objc func listen(_ call: CAPPluginCall) {
    let port = call.getInt("port") ?? 0

    sockets?.listen(port: UInt16(port)) { outcome in
      switch outcome {
      case .success(let bound):
        call.resolve(["port": Int(bound)])
      case .failure(let error):
        call.reject("could not listen: \(error.localizedDescription)")
      }
    }
  }

  @objc func stopListening(_ call: CAPPluginCall) {
    sockets?.stopListening()
    call.resolve()
  }

  deinit {
    sockets?.closeAll()
  }
}
