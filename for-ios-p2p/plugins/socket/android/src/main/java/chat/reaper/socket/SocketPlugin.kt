package chat.reaper.socket

import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * `TcpSockets` as seen from the WebView, on Android.
 *
 * The counterpart to iOS's `SocketPlugin.swift` — same contract, same
 * `jsName`, so `plugins/socket/src/index.ts` does not need to know which
 * platform it is talking to.
 */
@CapacitorPlugin(name = "Socket")
class SocketPlugin : Plugin() {

    private lateinit var sockets: TcpSockets

    override fun load() {
        sockets = TcpSockets { id, event, payload ->
            payload.put("id", id)
            // One channel for every socket rather than one per id: listeners
            // are not free, and the transport demultiplexes by id anyway.
            notifyListeners(event, payload)
        }
    }

    @PluginMethod
    fun connect(call: PluginCall) {
        val id = call.getString("id")
        val host = call.getString("host")
        val port = call.getInt("port")
        if (id == null || host == null || port == null) {
            call.reject("id, host and port are required")
            return
        }

        // 9050 is Tor's default. Passed in rather than assumed because the
        // client embedded in the app picks its own port to avoid colliding
        // with a Tor the user may already be running.
        val proxy = call.getInt("proxyPort") ?: 9050

        sockets.connect(id, host, port, proxy)

        // Resolves when the request has been made, not when it succeeds. The
        // outcome arrives as a `connect` or an `error` event, because a
        // connection over Tor can take twenty seconds and a promise held open
        // that long looks like the app has hung.
        call.resolve()
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val id = call.getString("id")
        val base64 = call.getString("data")
        if (id == null || base64 == null) {
            call.reject("id and base64 data are required")
            return
        }

        val data = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            call.reject("id and base64 data are required")
            return
        }

        sockets.send(id, data)
        call.resolve()
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val id = call.getString("id")
        if (id == null) {
            call.reject("id is required")
            return
        }

        sockets.close(id)
        call.resolve()
    }

    /**
     * Bind a loopback port, and resolve only once it is actually bound.
     *
     * The port is what Tor is told to forward its onion service to, so
     * resolving early with a placeholder is worse than failing: Tor is
     * handed a target of zero, refuses, and the app reports that nothing can
     * be sent or received — which describes the consequence and not the
     * cause.
     */
    @PluginMethod
    fun listen(call: PluginCall) {
        val port = call.getInt("port") ?: 0

        sockets.listen(port) { outcome ->
            outcome.fold(
                onSuccess = { bound -> call.resolve(JSObject().put("port", bound)) },
                onFailure = { error -> call.reject("could not listen: ${error.message}") },
            )
        }
    }

    /**
     * Stop one listener, or all of them.
     *
     * The port is what identifies it. This device runs two — the chat
     * transport behind the account address and the pairing service behind
     * the sync address — so a `stopListening` with no port used to take both
     * down, and the caller that meant to close one closed the other as
     * collateral.
     */
    @PluginMethod
    fun stopListening(call: PluginCall) {
        sockets.stopListening(call.getInt("port") ?: 0)
        call.resolve()
    }

    /**
     * Which ports are already bound, oldest first.
     *
     * The WebView reloads when a device is linked, and Capacitor rebuilds its
     * plugins with it — but `sockets` outlives that, and so do its listeners.
     * Tor outlives it too and goes on forwarding to the same ports. This is
     * how the new page finds them again.
     */
    @PluginMethod
    fun listeningPorts(call: PluginCall) {
        call.resolve(JSObject().put("ports", JSArray(sockets.listeningPorts())))
    }

    override fun handleOnDestroy() {
        sockets.closeAll()
    }
}
