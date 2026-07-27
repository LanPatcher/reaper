import Capacitor
import Foundation

/**
 * `TorService` as seen from the WebView.
 *
 * Thin, like the other two: everything that decides how Tor behaves is in
 * `TorService.swift`, and this is the part that talks to JavaScript.
 *
 * `start` resolves immediately rather than when Tor is usable. Bootstrapping a
 * circuit takes seconds to minutes and publishing an onion descriptor takes
 * longer again, so progress arrives as events — `bootstrapping` with a
 * percentage, then `ready` with the SOCKS port, then `published` with the
 * address. A promise held open across all of that is indistinguishable from a
 * hang, and the interface has something honest to show at every stage.
 */
@objc(TorPlugin)
public class TorPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TorPlugin"
    public let jsName = "Tor"

    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
    ]

    private var tor: TorService?

    override public func load() {
        tor = TorService { [weak self] state, detail in
            var data = detail
            data["state"] = state
            self?.notifyListeners("tor", data: data)
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let port = call.getInt("localPort"), port > 0, port < 65536 else {
            call.reject("localPort is required — Tor has to know where to forward to")
            return
        }

        tor?.start(localPort: UInt16(port))
        call.resolve(["running": tor?.running ?? false])
    }

    @objc func stop(_ call: CAPPluginCall) {
        tor?.stop()
        call.resolve(["running": false])
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve([
            "running": tor?.running ?? false,
            "bootstrapped": tor?.bootstrapped ?? false,
            "socksPort": Int(tor?.socksPort ?? 0),
            "onion": tor?.onion as Any,
            "error": tor?.lastError as Any,
        ])
    }

    deinit {
        tor?.stop()
    }
}
