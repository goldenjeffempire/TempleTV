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
import expo.modules.kotlin.functions.Coroutine
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
        private const val RC_CLOSE              = 9005
        private const val CHANNEL_ID            = "pip_controls_channel"
        private const val ACTION_PIP_PLAY       = "expo.modules.pipandroid.ACTION_PLAY"
        private const val ACTION_PIP_PAUSE      = "expo.modules.pipandroid.ACTION_PAUSE"
        private const val ACTION_PIP_CLOSE      = "expo.modules.pipandroid.ACTION_CLOSE"

        // Module-level flag: createNotificationChannel() is idempotent by spec, but
        // constructing the NotificationChannel object on every notification post
        // allocates unnecessary garbage. Skip after the first successful creation.
        @Volatile private var channelCreated = false
    }

    private val currentActivity: Activity?
        get() = appContext.activityProvider?.currentActivity

    // ── Media-control BroadcastReceiver ──────────────────────────────────────
    // Receives play/pause/close intents from RemoteActions inside the PiP overlay
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
                    ACTION_PIP_CLOSE -> "close"
                    else             -> return
                }
                sendEvent("onPipAction", mapOf("action" to action))
            }
        }
        val filter = IntentFilter().apply {
            addAction(ACTION_PIP_PLAY)
            addAction(ACTION_PIP_PAUSE)
            addAction(ACTION_PIP_CLOSE)
        }
        // API 33+ requires an explicit exported/non-exported flag.
        // This receiver is package-internal only (PendingIntents created with
        // setPackage(packageName)), so RECEIVER_NOT_EXPORTED is correct and safe.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
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

        // JS can listen for "onPipAction" events with
        //   { action: "play" | "pause" | "close" }
        // to respond to media control buttons pressed inside the PiP overlay.
        // "close" (Android 15 / API 35+) fires when the user taps the PiP close
        // button; the player should stop playback and release resources.
        Events("onPipAction")

        OnDestroy {
            unregisterPipReceiver()
        }

        // ── enterPictureInPicture ───────────────────────────────────────────────
        // Enters PiP immediately. Arms media controls (play/pause) and an optional
        // restore button inside the PiP overlay, sets the window title on Android 12+
        // (API 31), and on Android 15+ (API 35) registers a custom close action so
        // tapping the PiP close button fires a "close" JS event instead of silently
        // destroying the activity while media continues in the background.
        //
        // Uses AsyncFunction("…") Coroutine { … } (expo-modules-core 3.x builder
        // syntax) + suspendCancellableCoroutine to safely bridge the UI-thread work
        // back to this coroutine without blocking a thread pool slot.
        // The AsyncFunction("…") { crossinline … } shorthand does NOT support
        // suspend calls — Coroutine { } is required for any suspend body in EMC 3.x.

        AsyncFunction("enterPictureInPicture") Coroutine {
            aspectWidth: Int, aspectHeight: Int,
            withRestore: Boolean, title: String?, isPlaying: Boolean ->

            if (Build.VERSION.SDK_INT < 26) return@Coroutine false
            val act = currentActivity ?: return@Coroutine false
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

                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                            // Display the video / broadcast title in the PiP chrome.
                            val effectiveTitle = title?.takeIf { it.isNotBlank() } ?: "Temple TV"
                            builder.setTitle(effectiveTitle)
                            // Smooth video crossfade when the PiP window is resized.
                            builder.setSeamlessResizeEnabled(true)
                        }

                        // Android 15 (API 35 / VANILLA_ICE_CREAM): register a custom
                        // close action so the player receives a "close" JS event when
                        // the user taps the PiP window's close button. Without this,
                        // closing the PiP window silently destroys the overlay while
                        // media continues playing invisibly in the background.
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                            buildCloseAction(act)?.let { builder.setCloseAction(it) }
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

        AsyncFunction("updatePipParams") Coroutine {
            aspectWidth: Int, aspectHeight: Int,
            withRestore: Boolean, autoEnter: Boolean,
            title: String?, isPlaying: Boolean ->

            if (Build.VERSION.SDK_INT < 26) return@Coroutine null
            val act = currentActivity ?: return@Coroutine null
            registerPipReceiver()

            suspendCancellableCoroutine<Unit> { cont ->
                act.runOnUiThread {
                    try {
                        val builder = PictureInPictureParams.Builder()
                            .setAspectRatio(Rational(
                                aspectWidth.coerceAtLeast(1),
                                aspectHeight.coerceAtLeast(1),
                            ))

                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                            val effectiveTitle = title?.takeIf { it.isNotBlank() } ?: "Temple TV"
                            builder.setTitle(effectiveTitle)
                            builder.setAutoEnterEnabled(autoEnter)
                            builder.setSeamlessResizeEnabled(true)
                        }

                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                            buildCloseAction(act)?.let { builder.setCloseAction(it) }
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

        // ── disableAutoEnterPip ───────────────────────────────────────────────
        // Explicitly disables PiP auto-enter without changing any other params.
        // Call this when the player is torn down or the user navigates away, so
        // the OS does not auto-enter PiP on the home gesture when nothing is playing.
        //
        // More targeted than updatePipParams(autoEnter=false) because it only
        // touches the autoEnter flag — it does not reset aspect ratio, title, or
        // action buttons that might still be needed for a concurrent PiP session.
        // Safe no-op below API 31 (autoEnter did not exist before S).

        AsyncFunction("disableAutoEnterPip") Coroutine {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Coroutine null
            val act = currentActivity ?: return@Coroutine null

            suspendCancellableCoroutine<Unit> { cont ->
                act.runOnUiThread {
                    try {
                        act.setPictureInPictureParams(
                            PictureInPictureParams.Builder()
                                .setAutoEnterEnabled(false)
                                .build()
                        )
                    } catch (_: Exception) { /* non-fatal */ }
                    if (cont.isActive) cont.resume(Unit)
                }
            }
            null
        }

        // ── cancelPipRestoreNotification ────────────────────────────────────────
        // No suspend work needed — regular AsyncFunction (crossinline) is fine.

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
     * Uses bundled vector drawables (ic_pip_play.xml / ic_pip_pause.xml) that are
     * always present in this module's resources.  These are flat white-on-transparent
     * vectors that satisfy Android's notification-icon and RemoteAction-icon format
     * requirements (API 21+ silhouette mode, AOSP + OEM compatible).  Using module-
     * owned drawables avoids reliance on android.R.drawable system resources whose
     * visual appearance varies across OEM skins and Android versions.
     */
    private fun buildPlayPauseAction(act: Activity, isPlaying: Boolean): RemoteAction? {
        if (Build.VERSION.SDK_INT < 26) return null

        val (action, rc, iconRes, label, desc) = if (isPlaying) {
            PlayPauseSpec(ACTION_PIP_PAUSE, RC_PAUSE,
                R.drawable.ic_pip_pause, "Pause", "Pause playback")
        } else {
            PlayPauseSpec(ACTION_PIP_PLAY, RC_PLAY,
                R.drawable.ic_pip_play, "Play", "Resume playback")
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
     * Android 15 (API 35 / VANILLA_ICE_CREAM): Custom close action for the PiP
     * window's close button.
     *
     * When the user taps the close (×) button on the PiP window, this broadcasts
     * ACTION_PIP_CLOSE so JS receives a { action: "close" } event. The player can
     * then stop playback and release resources cleanly, instead of the media
     * continuing invisibly in the background after the overlay is gone.
     *
     * Only available on API 35+ — earlier Android versions do not have a
     * configurable close button in the PiP chrome; the system shows its own
     * dismiss control that destroys the overlay without any app callback.
     *
     * Requires compileSdk 35+ (available since compileSdk 36 in this project).
     * The enclosing call site must guard with SDK_INT >= VANILLA_ICE_CREAM.
     */
    private fun buildCloseAction(act: Activity): RemoteAction? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return null
        val intent = Intent(ACTION_PIP_CLOSE).setPackage(act.packageName)
        val pi = PendingIntent.getBroadcast(
            act, RC_CLOSE, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // ic_pip_expand (restore icon) serves double duty here: visually it means
        // "go back to the full app", which is the expected outcome of closing the
        // PiP window. Using a module-owned drawable avoids the lint warning about
        // android.R.drawable system resources and ensures OEM-skin consistency.
        return RemoteAction(
            Icon.createWithResource(act, R.drawable.ic_pip_expand),
            "Close",
            "Stop and close mini player",
            pi,
        )
    }

    /**
     * Post a low-priority persistent notification so the user can restore the
     * full-screen player from anywhere. Auto-cancelled on next Activity resume
     * (native ActivityLifecycleCallbacks) and from JS on PiP exit.
     *
     * Android 13+ (API 33 / TIRAMISU): POST_NOTIFICATIONS is a runtime permission.
     * We gate on NotificationManager.areNotificationsEnabled() so we never throw
     * SecurityException on devices where the user denied the permission — which
     * would surface as a visible crash or native error log with no user-visible
     * recovery path.
     *
     * Channel creation is guarded by the module-level channelCreated flag so we
     * only construct the NotificationChannel object once per process lifetime —
     * createNotificationChannel() is idempotent (the OS deduplicates on channelId)
     * but constructing the object allocates garbage on every notification post.
     */
    private fun postRestoreNotification(act: Activity) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = act.getSystemService(Activity.NOTIFICATION_SERVICE)
            as? NotificationManager ?: return

        // Android 13+ runtime permission guard.
        // areNotificationsEnabled() checks both the app-level notification enable
        // flag AND the specific channel (pre-26 it checks the global app flag only).
        // Returns false if the user denied POST_NOTIFICATIONS OR disabled notifs.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && !nm.areNotificationsEnabled()) return

        // Idempotent channel creation — skip on subsequent calls.
        if (!channelCreated) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Media Controls",
                    NotificationManager.IMPORTANCE_LOW,
                )
            )
            channelCreated = true
        }

        val intent = act.packageManager.getLaunchIntentForPackage(act.packageName) ?: return
        val pi = PendingIntent.getActivity(
            act, RC_RESTORE, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = Notification.Builder(act, CHANNEL_ID)
            .setContentTitle("Temple TV")
            .setContentText("Playing in mini player — tap to return to full screen")
            // ic_pip_expand is a flat white/transparent vector (API 21+ silhouette-safe).
            // Using a module-owned drawable instead of android.R.drawable eliminates
            // the NotificationIconCompatibility lint warning and ensures visual
            // consistency across OEM skins that may override system drawables.
            .setSmallIcon(R.drawable.ic_pip_expand)
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
