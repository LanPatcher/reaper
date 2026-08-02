package chat.reaper.keepalive

import android.Manifest
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PermissionState
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * `KeepaliveService` as seen from the WebView, on Android.
 *
 * The counterpart to iOS's `KeepalivePlugin.swift` — same contract, same
 * `jsName`, so `plugins/keepalive/src/index.ts` does not need to know which
 * platform it is talking to. The mechanism underneath is genuinely
 * different (a foreground service, not an audio session — see
 * `KeepaliveService.kt`), but what the WebView calls and what events it
 * gets back are identical.
 */
@CapacitorPlugin(
    name = "Keepalive",
    permissions = [
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
    ],
)
class KeepalivePlugin : Plugin(), DefaultLifecycleObserver {

    override fun load() {
        // Whole-app foreground/background, not per-`Activity` — the one
        // thing `Activity.onStart`/`onStop` cannot give on their own. Those
        // fire on every screen transition, including this activity handing
        // off to another one *within* the app, which is not backgrounding
        // at all. `ProcessLifecycleOwner` collapses that down to the single
        // question `didEnterBackgroundNotification`/`willEnterForeground`
        // answer on iOS.
        ProcessLifecycleOwner.get().lifecycle.addObserver(this)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        // Refused is a perfectly reasonable answer, and the service starts
        // either way — the permission gates only whether the notification
        // Android requires in exchange is actually *visible*, not whether
        // the foreground grant itself is honoured. Asked anyway, because a
        // silently-invisible "the app is running" notice is worse than
        // asking once and having it declined.
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermCallback")
            return
        }
        doStart(call)
    }

    @PermissionCallback
    private fun notificationPermCallback(call: PluginCall) {
        doStart(call)
    }

    private fun doStart(call: PluginCall) {
        KeepaliveService.start(context)
        call.resolve(JSObject().put("running", true).put("error", null))
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        KeepaliveService.stop(context)
        call.resolve(JSObject().put("running", false))
    }

    /**
     * A no-op on Android — see `plugins/keepalive/src/index.ts`. The
     * foreground service already grants full background execution
     * regardless of call state, so there is no equivalent trade to make
     * here the way iOS's audio-category dance has to.
     */
    @PluginMethod
    fun setInCall(call: PluginCall) {
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun status(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("running", KeepaliveService.running)
                .put("error", null),
        )
    }

    override fun onStop(owner: LifecycleOwner) {
        notifyListeners("backgrounded", JSObject().put("running", KeepaliveService.running))
    }

    override fun onStart(owner: LifecycleOwner) {
        // The service may have been stopped while away — recovering here
        // costs nothing, and being wrong about it costs every message sent
        // in the meantime. The same reasoning `KeepalivePlugin.swift` uses
        // to re-arm its own session on `enteredForeground`.
        if (!KeepaliveService.running) {
            KeepaliveService.start(context)
        }

        notifyListeners("foregrounded", JSObject().put("running", KeepaliveService.running))
    }
}
