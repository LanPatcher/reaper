package chat.reaper.keepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Stays alive in the background, honestly.
 *
 * ## Why a foreground service, not an audio trick
 *
 * iOS grants indefinite background execution to an app playing audio, which is
 * why `Keepalive.swift` holds a silent audio session open — there is no more
 * direct route available to it. Android has one: a foreground service is a
 * *sanctioned* "stay alive" grant, not a workaround, in exchange for exactly
 * one thing the platform requires of it — a persistent notification, so the
 * user always knows something is running on their behalf.
 *
 * ## Why merely running this is enough
 *
 * This service does not itself touch tor or any socket. It does not need to:
 * a foreground service's actual effect is on the *process* it runs in, not on
 * whichever component happens to be the one keeping it alive. As long as this
 * runs in the app's normal process — it does; nothing here asks for
 * `android:process=":remote"` — the WebView, the tor subprocess, and every
 * open socket that process already holds keep running exactly as they would
 * in the foreground, for as long as this service does. The notification is
 * the visible cost of that; nothing else about how the app works changes.
 *
 * ## What this still does not achieve
 *
 * Worth being as straight about this as `Keepalive.swift` is about iOS:
 *
 *   - **Memory pressure can still kill the whole process.** `START_STICKY`
 *     asks Android to recreate this service if that happens, but a recreated
 *     service in a fresh process is not the process that was running before
 *     — the tor subprocess and every open socket are gone with it, and there
 *     is no WebView in a bare recreated service to restart them from. Nothing
 *     is reachable again until the app itself is opened.
 *   - **A reboot ends it.** Nothing restarts the app until it is opened.
 *   - **Force-stopping the app from system settings ends it**, and Android
 *     will not restart a force-stopped app's services on its own.
 *   - **Swiping the app away from Recents can end it too**, on OEM skins that
 *     treat that as "stop everything belonging to this app" regardless of a
 *     foreground service being active — the direct Android analogue of
 *     iOS's force-quit, and equally outside this service's control.
 *
 * So, the same as iOS: reachability is "usually", not "always" — reached here
 * by a stronger, platform-sanctioned mechanism, but still not an
 * unconditional one.
 */
class KeepaliveService : Service() {

    companion object {
        private const val CHANNEL_ID = "reaper.keepalive"
        private const val NOTIFICATION_ID = 1

        /** Whether the service is currently running — read by `KeepalivePlugin`. */
        @Volatile
        var running: Boolean = false
            private set

        fun start(context: Context) {
            val intent = Intent(context, KeepaliveService::class.java)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, KeepaliveService::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()

        // The service type argument only exists from Q, and only became a
        // hard requirement (matching the manifest declaration) on U — passed
        // on every version it is accepted, since there is no reason not to.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        running = true

        // See the class doc: this asks to be recreated, but a recreation is
        // not a resurrection of the process that was actually keeping this
        // device reachable. It costs nothing to ask for anyway.
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = getSystemService(NotificationManager::class.java) ?: return

        // MIN rather than LOW or DEFAULT: this is not news, it is the
        // ordinary state of a working app, so it collapses into the shade
        // without a sound or a heads-up interruption — the Android
        // equivalent of iOS's silent audio buffer being genuinely silent.
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Staying reachable",
            NotificationManager.IMPORTANCE_MIN,
        ).apply {
            description = "Keeps Reaper listening for messages while it is not on screen."
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val openApp = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = openApp?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Reaper is running")
            .setContentText("Listening for messages in the background.")
            // The app's own launcher icon rather than a dedicated monochrome
            // status-bar glyph — functionally correct (Android accepts any
            // drawable here) but not what a status-bar icon is meant to look
            // like; the system tints it to a silhouette on API 21+; a proper
            // `ic_stat_reaper` is worth adding alongside the app's other icon
            // assets later.
            .setSmallIcon(applicationInfo.icon)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .build()
    }
}
