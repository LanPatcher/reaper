package chat.reaper.tor

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * `TorService` as seen from the WebView, on Android.
 *
 * The counterpart to iOS's `TorPlugin.swift` — same contract, same `jsName`,
 * so `plugins/tor/src/index.ts` does not need to know which platform it is
 * talking to. `start` resolves as soon as tor is launched; bootstrapping and
 * publishing arrive as `tor` events, the same as on iOS.
 */
@CapacitorPlugin(name = "Tor")
class TorPlugin : Plugin() {

    private lateinit var tor: TorService

    override fun load() {
        tor = TorService(context) { state, detail ->
            detail.put("state", state)
            notifyListeners("tor", detail)
        }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val port = call.getInt("localPort")
        if (port == null || port <= 0 || port >= 65536) {
            call.reject("localPort is required — Tor has to know where to forward to")
            return
        }

        // A second port for the sync service, when the caller has one. The
        // device link listens separately from the peer transport, so the two
        // onion services forward to different places.
        val syncPort = (call.getInt("syncPort") ?: 0).coerceIn(0, 65535)

        // Whether to publish the account address from this device at all.
        // Absent means yes, which is right for the only-device case.
        val account = call.getBoolean("account") ?: true

        tor.start(port, syncPort, account)
        call.resolve(JSObject().put("running", tor.running))
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        tor.stop()
        call.resolve(JSObject().put("running", false))
    }

    @PluginMethod
    fun status(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("running", tor.running)
                .put("bootstrapped", tor.bootstrapped)
                .put("socksPort", tor.socksPort)
                .put("onion", tor.onion)
                .put("syncOnion", tor.syncOnion)
                .put("error", tor.lastError),
        )
    }

    /**
     * This device's service key, for an identity backup.
     *
     * Read from disk rather than from the running client, so it works before
     * tor has bootstrapped — an export should not require waiting for a
     * circuit.
     */
    @PluginMethod
    fun exportKey(call: PluginCall) {
        call.resolve(TorService.exportKey(context))
    }

    /**
     * Adopt an address from a backup.
     *
     * Written to disk and picked up on the next launch, the same as iOS —
     * tor reads its service directories once at startup on every platform,
     * so "close and reopen" is the honest instruction here too, not just a
     * workaround for iOS's inability to restart the linked framework.
     */
    @PluginMethod
    fun importKey(call: PluginCall) {
        val secret = call.getString("secret")
        val publicKey = call.getString("public")
        if (secret == null || publicKey == null) {
            call.reject("that backup does not contain an onion key")
            return
        }

        val hostname = call.getString("hostname") ?: ""

        try {
            TorService.importKey(context, secret, publicKey, hostname)
        } catch (e: Exception) {
            call.reject(e.message ?: "could not import that key")
            return
        }

        call.resolve(JSObject().put("hostname", hostname).put("needsRestart", true))
    }

    // Deliberately no `handleOnDestroy` stopping tor here. This fires on an
    // ordinary WebView reload too (linking a device, importing an identity),
    // which Capacitor rebuilds its plugins across — and the whole point of
    // TorService's companion-object process handle is that tor keeps running
    // underneath that. It is torn down with the app process, not with this
    // object; an explicit `stop()` call remains available for whoever
    // actually wants to stop it.
}
