package expo.modules.pipandroid

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

class ExpoPipAndroidModule : Module() {

    companion object {
        private const val NOTIFICATION_ID       = 9001
        private const val RC_RESTORE            = 9002
        private const val RC_PLAY               = 9003
        private const val RC_PAUSE              = 9004
        private const val CHANNEL_ID            = "pip_controls_channel"
        private const val ACTION_PIP_PLAY       = "expo.modules.pipandroid.ACTION_PLAY"
        private const val ACTION_PIP_PAUSE      = "expo.modules.pipandroid.ACTION_PAUSE"
    }

    private val currentActivity: Activity?
        get() = appContext.activityProvider?.currentActivity

    // ── Media-control BroadcastReceiver ──────────────────────────────────────
    // Receives play/pause intents from RemoteActions inside the PiP overlay
    // and forwards them to JS via the Expo events system so the player can
    // react without requiring a native-module bridge call.
    private var pipReceiver: BroadcastReceiver? = null

    private fun registerPipReceiver() {
        if (pipReceiver != null) return
        val ctx = appContext.reactContext ?: return

        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val action = when (intent?.action) {
                    ACTION_PIP_PLAY  -> "play"
                    ACTION_PIP_PAUSE -> "pause"
                    else             -> return
                }
                sendEvent("onPipAction", mapOf("action" to action))
            }
        }
        val filter = IntentFilter().apply {
            addAction(ACTION_PIP_PLAY)
            addAction(ACTION_PIP_PAUSE)
        }
        // API 33+ requires an explicit exported/non-exported flag.
        // This receiver is package-internal only (PendingIntents created with
        // setPackage(packageName)), so RECEIVER_NOT_EXPORTED is correct and safe.
        if (Build.VERSION.SDK_INT >= 33) {
            ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(receiver, filter)
        }
        pipReceiver = receiver
    }

    private fun unregisterPipReceiver() {
        val ctx = appContext.reactContext ?: return
        pipReceiver?.let {
            try { ctx.unregisterReceiver(it) } catch (_: Exception) {}
            pipReceiver = null
        }
    }

    // ── Module definition ─────────────────────────────────────────────────────

    override fun definition() = ModuleDefinition {

        Name("ExpoPipAndroid")

        // JS can listen for "onPipAction" events with { action: "play" | "pause" }
        // to respond to media control buttons pressed inside the PiP overlay.
        Events("onPipAction")

        OnDestroy {
            unregisterPipReceiver()
        }

        // ── enterPictureInPicture ───────────────────────────────────────────────
        // Enters PiP immediately. Arms media controls (play/pause) and an optional
        // restore button inside the PiP overlay, and sets the window title on
        // Android 12+ (API 31) so viewers know what is playing.
        //
        // Uses suspendCancellableCoroutine instead of CountDownLatch to safely
        // bridge the UI-thread work back to this (background) coroutine without
        // blocking a thread pool slot. CountDownLatch.await() on the Expo module
        // dispatcher thread could exhaust the thread pool under concurrent calls
        // and trigger an ANR if the UI thread is congested during the 5-second
        // timeout window. suspendCancellableCoroutine suspends — releases the
        // thread — until runOnUiThread completes and resumes the coroutine.

        AsyncFunction("enterPictureInPicture") {
            aspectWidth: Int, aspectHeight: Int,
            withRestore: Boolean, title: String?, isPlaying: Boolean ->

            if (Build.VERSION.SDK_INT < 26) return@AsyncFunction false
            val act = currentActivity ?: return@AsyncFunction false
            registerPipReceiver()

            suspendCancellableCoroutine { cont ->
                act.runOnUiThread {
                    var result = false
                    try {
                        val builder = PictureInPictureParams.Builder()
                            .setAspectRatio(Rational(
                                aspectWidth.coerceAtLeast(1),
                                aspectHeight.coerceAtLeast(1),
                            ))

                        if (Build.VERSION.SDK_INT >= 31) {
                            // Display the video / broadcast title in the PiP chrome.
                            val effectiveTitle = title?.takeIf { it.isNotBlank() } ?: "Temple TV"
                            builder.setTitle(effectiveTitle)
                            // Smooth video crossfade when the PiP window is resized.
                            builder.setSeamlessResizeEnabled(true)
                        }

                        val actions = buildPipActions(act, isPlaying, withRestore)
                        if (actions.isNotEmpty()) builder.setActions(actions)

                        result = act.enterPictureInPictureMode(builder.build())

                        if (result && withRestore) postRestoreNotification(act)
                    } catch (_: Exception) {
                        result = false
                    }
                    if (cont.isActive) cont.resume(result)
                }
            }
        }

        // ── isPictureInPictureSupported ─────────────────────────────────────────

        Function("isPictureInPictureSupported") {
            if (Build.VERSION.SDK_INT < 26) return@Function false
            currentActivity?.packageManager
                ?.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
                ?: false
        }

        // ── isInPictureInPictureMode ────────────────────────────────────────────

        Function("isInPictureInPictureMode") {
            if (Build.VERSION.SDK_INT < 26) return@Function false
            currentActivity?.isInPictureInPictureMode ?: false
        }

        // ── updatePipParams ────────────────────────────────────────────────────
        // Pre-registers PiP params so Android uses the correct aspect ratio,
        // actions, and title immediately when the user or OS triggers PiP.
        // Also updates the live media controls (play ↔ pause icon) while already
        // in PiP — call this whenever the playback state changes.
        //
        // Uses suspendCancellableCoroutine for the same ANR-safety reasons as
        // enterPictureInPicture above.

        AsyncFunction("updatePipParams") {
            aspectWidth: Int, aspectHeight: Int,
            withRestore: Boolean, autoEnter: Boolean,
            title: String?, isPlaying: Boolean ->

            if (Build.VERSION.SDK_INT < 26) return@AsyncFunction null
            val act = currentActivity ?: return@AsyncFunction null
            registerPipReceiver()

            suspendCancellableCoroutine { cont ->
                act.runOnUiThread {
                    try {
                        val builder = PictureInPictureParams.Builder()
                            .setAspectRatio(Rational(
                                aspectWidth.coerceAtLeast(1),
                                aspectHeight.coerceAtLeast(1),
                            ))

                        if (Build.VERSION.SDK_INT >= 31) {
                            val effectiveTitle = title?.takeIf { it.isNotBlank() } ?: "Temple TV"
                            builder.setTitle(effectiveTitle)
                            builder.setAutoEnterEnabled(autoEnter)
                            builder.setSeamlessResizeEnabled(true)
                        }

                        val actions = buildPipActions(act, isPlaying, withRestore)
                        if (actions.isNotEmpty()) builder.setActions(actions)

                        act.setPictureInPictureParams(builder.build())
                    } catch (_: Exception) {
                        // Non-fatal — params fall back to defaults
                    }
                    if (cont.isActive) cont.resume(Unit)
                }
            }
            null
        }

        // ── cancelPipRestoreNotification ────────────────────────────────────────

        AsyncFunction("cancelPipRestoreNotification") {
            val act = currentActivity ?: return@AsyncFunction null
            val nm = act.getSystemService(Activity.NOTIFICATION_SERVICE) as? NotificationManager
            nm?.cancel(NOTIFICATION_ID)
            null
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Build the ordered list of RemoteActions for the PiP overlay.
     *
     * Action order matters — Android displays them left-to-right in the order
     * returned. Play/Pause first (primary interaction), Restore last (secondary).
     * Maximum of 3 actions on most devices; excess actions are silently dropped.
     */
    private fun buildPipActions(
        act: Activity,
        isPlaying: Boolean,
        withRestore: Boolean,
    ): List<RemoteAction> {
        if (Build.VERSION.SDK_INT < 26) return emptyList()
        val actions = mutableListOf<RemoteAction>()

        // Play / Pause — primary media control.
        buildPlayPauseAction(act, isPlaying)?.let { actions += it }

        // Restore — returns the user to the full-screen player.
        if (withRestore) buildRestoreAction(act)?.let { actions += it }

        return actions
    }

    /**
     * Play or Pause RemoteAction.
     *
     * Uses the public stable system drawables [android.R.drawable.ic_media_play]
     * and [android.R.drawable.ic_media_pause] (API 1+, present on all AOSP and
     * OEM ROMs). When tapped, broadcasts ACTION_PIP_PLAY or ACTION_PIP_PAUSE to
     * [pipReceiver], which emits "onPipAction" to JS.
     */
    private fun buildPlayPauseAction(act: Activity, isPlaying: Boolean): RemoteAction? {
        if (Build.VERSION.SDK_INT < 26) return null

        val (action, rc, iconRes, label, desc) = if (isPlaying) {
            PlayPauseSpec(ACTION_PIP_PAUSE, RC_PAUSE,
                android.R.drawable.ic_media_pause, "Pause", "Pause playback")
        } else {
            PlayPauseSpec(ACTION_PIP_PLAY, RC_PLAY,
                android.R.drawable.ic_media_play, "Play", "Resume playback")
        }

        val intent = Intent(action).setPackage(act.packageName)
        val pi = PendingIntent.getBroadcast(
            act, rc, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return RemoteAction(Icon.createWithResource(act, iconRes), label, desc, pi)
    }

    /**
     * Expand / Restore RemoteAction.
     *
     * Uses a bundled vector drawable (ic_pip_expand.xml) that is always present
     * in this module's resources, avoiding reliance on any internal system drawable
     * that may be absent on OEM devices. Launches the app to return from the PiP
     * window to the full-screen player.
     */
    private fun buildRestoreAction(act: Activity): RemoteAction? {
        if (Build.VERSION.SDK_INT < 26) return null
        val intent = act.packageManager.getLaunchIntentForPackage(act.packageName)
            ?: return null
        val pi = PendingIntent.getActivity(
            act, RC_RESTORE, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return RemoteAction(
            Icon.createWithResource(act, R.drawable.ic_pip_expand),
            "Open",
            "Return to full screen",
            pi,
        )
    }

    /**
     * Post a low-priority persistent notification so the user can restore the
     * full-screen player from anywhere. Auto-cancelled on next Activity resume
     * (native ActivityLifecycleCallbacks) and from JS on PiP exit.
     *
     * Uses the two-arg [Notification.Builder(context, channelId)] constructor
     * which is the correct modern API 26+ form — NOT the single-arg deprecated
     * form. The channel importance (IMPORTANCE_LOW) is the sole visual-priority
     * control on API 26+; per-notification setPriority() is ignored when a
     * channel is present and is intentionally omitted.
     */
    private fun postRestoreNotification(act: Activity) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = act.getSystemService(Activity.NOTIFICATION_SERVICE)
            as? NotificationManager ?: return

        val channel = NotificationChannel(
            CHANNEL_ID,
            "Media Controls",
            NotificationManager.IMPORTANCE_LOW,
        )
        nm.createNotificationChannel(channel)

        val intent = act.packageManager.getLaunchIntentForPackage(act.packageName) ?: return
        val pi = PendingIntent.getActivity(
            act, RC_RESTORE, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = Notification.Builder(act, CHANNEL_ID)
            .setContentTitle("Temple TV")
            .setContentText("Playing in mini player — tap to return to full screen")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()

        nm.notify(NOTIFICATION_ID, notification)
    }

    // Simple data holder to avoid positional argument confusion in buildPlayPauseAction.
    private data class PlayPauseSpec(
        val action: String,
        val requestCode: Int,
        val iconRes: Int,
        val label: String,
        val desc: String,
    )
}
