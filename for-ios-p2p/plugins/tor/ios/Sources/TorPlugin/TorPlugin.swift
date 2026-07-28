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
        CAPPluginMethod(name: "exportKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importKey", returnType: CAPPluginReturnPromise),
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

        // A second port for the sync service, when the caller has one. The
        // device link listens separately from the peer transport, so the two
        // onion services forward to different places.
        let syncPort = call.getInt("syncPort") ?? 0

        tor?.start(localPort: UInt16(port), syncPort: UInt16(max(0, min(65535, syncPort))))
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

            // Where this device's own siblings reach it. Separate from the
            // account address on purpose — see TorService.swift.
            "syncOnion": tor?.syncOnion as Any,
            "error": tor?.lastError as Any,
        ])
    }

    /**
     * The service key, for an identity backup.
     *
     * Read from disk rather than from the running client, so it works before
     * Tor has bootstrapped — an export should not require waiting for a
     * circuit.
     */
    @objc func exportKey(_ call: CAPPluginCall) {
        call.resolve(TorService.exportKey())
    }

    /**
     * Adopt an address from a backup.
     *
     * The restart is the point. tor reads its service directory once at
     * startup, so writing the key without restarting leaves the device
     * publishing its old address while believing it has a new one — which is
     * the confusing half-state this whole feature exists to prevent.
     */
    @objc func importKey(_ call: CAPPluginCall) {
        guard
            let secret = call.getString("secret").flatMap({ Data(base64Encoded: $0) }),
            let publicKey = call.getString("public").flatMap({ Data(base64Encoded: $0) })
        else {
            call.reject("that backup does not contain an onion key")
            return
        }

        let hostname = call.getString("hostname") ?? ""

        do {
            try TorService.importKey(secret: secret, publicKey: publicKey, hostname: hostname)
        } catch {
            call.reject(error.localizedDescription)
            return
        }

        tor?.reload()
        call.resolve(["hostname": hostname])
    }

    deinit {
        tor?.stop()
    }
}
