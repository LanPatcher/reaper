package chat.reaper.keepalive

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

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
@CapacitorPlugin(name = "Keepalive")
class KeepalivePlugin : Plugin(), DefaultLifecycleObserver {

    /** Any request code the plugin owns; nothing here ever reads the result. */
    private val notificationPermissionRequest = 8401

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
        // Started unconditionally, before the permission is even looked at.
        // `boot.ts` awaits this call before starting the network — Tor,
        // every socket — so resolving late, or never, because a
        // notification permission dialog is sitting there unanswered would
        // hold the entire app hostage to it. The foreground grant this
        // service provides does not depend on the notification being
        // *visible*, only on the service running, so there is nothing here
        // actually worth waiting on.
        KeepaliveService.start(context)
        call.resolve(JSObject().put("running", true).put("error", null))

        // Asked separately, fire-and-forget: a silently-invisible "the app
        // is running" notice is worse than asking once and having it
        // declined, but it is a courtesy on top of an already-running
        // service, not a precondition for one — plain `ActivityCompat`
        // rather than Capacitor's permission-alias machinery, which ties
        // the request to resolving *this* call and would recreate the exact
        // blocking this is written to avoid.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            activity?.let {
                ActivityCompat.requestPermissions(
                    it,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    notificationPermissionRequest,
                )
            }
        }
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
