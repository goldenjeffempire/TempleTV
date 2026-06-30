package expo.modules.pipandroid

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ExpoPipAndroidModule : Module() {

    companion object {
        private const val NOTIFICATION_ID = 9001
        private const val REQUEST_CODE    = 9002
        private const val CHANNEL_ID      = "pip_restore_channel"
    }

    private val currentActivity: Activity?
        get() = appContext.activityProvider?.currentActivity

    override fun definition() = ModuleDefinition {

        Name("ExpoPipAndroid")

        // ── enterPictureInPicture ─────────────────────────────────────────────
        // Must run on UI thread. Uses CountDownLatch so the AsyncFunction
        // suspends until the enter attempt completes (or times out after 3 s).

        AsyncFunction("enterPictureInPicture") { aspectWidth: Int, aspectHeight: Int, withRestore: Boolean ->
            if (Build.VERSION.SDK_INT < 26) return@AsyncFunction false
            val act = currentActivity ?: return@AsyncFunction false

            var result = false
            val latch  = CountDownLatch(1)

            act.runOnUiThread {
                try {
                    val builder = PictureInPictureParams.Builder()
                        .setAspectRatio(Rational(aspectWidth.coerceAtLeast(1), aspectHeight.coerceAtLeast(1)))

                    if (Build.VERSION.SDK_INT >= 31 && withRestore) {
                        buildRestoreAction(act)?.let { builder.setActions(listOf(it)) }
                    }

                    // Smooth crossfade when the system resizes the PiP window
                    // for video content (API 31+). No-op below 31.
                    if (Build.VERSION.SDK_INT >= 31) {
                        builder.setSeamlessResizeEnabled(true)
                    }

                    result = act.enterPictureInPictureMode(builder.build())

                    if (withRestore) {
                        postRestoreNotification(act)
                    }
                } catch (_: Exception) {
                    result = false
                } finally {
                    latch.countDown()
                }
            }

            latch.await(3, TimeUnit.SECONDS)
            return@AsyncFunction result
        }

        // ── isPictureInPictureSupported ───────────────────────────────────────

        Function("isPictureInPictureSupported") {
            if (Build.VERSION.SDK_INT < 26) return@Function false
            currentActivity?.packageManager
                ?.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
                ?: false
        }

        // ── isInPictureInPictureMode ──────────────────────────────────────────

        Function("isInPictureInPictureMode") {
            if (Build.VERSION.SDK_INT < 26) return@Function false
            currentActivity?.isInPictureInPictureMode ?: false
        }

        // ── updatePipParams ───────────────────────────────────────────────────
        // Pre-registers PiP params so Android uses the correct aspect ratio and
        // actions immediately when the user gesture-triggers PiP (API 31+).

        AsyncFunction("updatePipParams") { aspectWidth: Int, aspectHeight: Int, withRestore: Boolean, autoEnter: Boolean ->
            if (Build.VERSION.SDK_INT < 26) return@AsyncFunction null
            val act = currentActivity ?: return@AsyncFunction null

            val latch = CountDownLatch(1)
            act.runOnUiThread {
                try {
                    val builder = PictureInPictureParams.Builder()
                        .setAspectRatio(Rational(aspectWidth.coerceAtLeast(1), aspectHeight.coerceAtLeast(1)))

                    if (Build.VERSION.SDK_INT >= 31 && withRestore) {
                        buildRestoreAction(act)?.let { builder.setActions(listOf(it)) }
                    }

                    // Modern system-driven automatic PiP (API 31+): the OS enters
                    // PiP itself the instant the activity is backgrounded while a
                    // video plays — far more reliable than the AppState-driven
                    // manual entry, which often races the background transition and
                    // is rejected. setSeamlessResizeEnabled gives a smooth video
                    // crossfade on resize. Both no-op below API 31, where the JS
                    // hook's AppState fallback handles auto-enter instead.
                    if (Build.VERSION.SDK_INT >= 31) {
                        builder.setAutoEnterEnabled(autoEnter)
                        builder.setSeamlessResizeEnabled(true)
                    }

                    act.setPictureInPictureParams(builder.build())
                } catch (_: Exception) {
                    // Non-fatal — params will fall back to defaults
                } finally {
                    latch.countDown()
                }
            }

            latch.await(3, TimeUnit.SECONDS)
            return@AsyncFunction null
        }

        // ── cancelPipRestoreNotification ──────────────────────────────────────

        AsyncFunction("cancelPipRestoreNotification") {
            val act = currentActivity ?: return@AsyncFunction null
            val nm = act.getSystemService(Activity.NOTIFICATION_SERVICE) as? NotificationManager
            nm?.cancel(NOTIFICATION_ID)
            return@AsyncFunction null
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /** Build a RemoteAction that returns the user to the full-screen player. */
    @Suppress("DEPRECATION")
    private fun buildRestoreAction(act: Activity): RemoteAction? {
        if (Build.VERSION.SDK_INT < 26) return null
        val intent = act.packageManager.getLaunchIntentForPackage(act.packageName) ?: return null
        val pi = PendingIntent.getActivity(
            act, REQUEST_CODE, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return RemoteAction(
            Icon.createWithResource(act, android.R.drawable.ic_menu_zoom),
            "Return",
            "Return to full screen",
            pi,
        )
    }

    /** Post a low-priority persistent notification so the user can restore
     *  the full-screen player from anywhere. Auto-cancelled on resume. */
    private fun postRestoreNotification(act: Activity) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = act.getSystemService(Activity.NOTIFICATION_SERVICE)
            as? NotificationManager ?: return

        // Create/update the notification channel (idempotent).
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Picture in Picture",
            NotificationManager.IMPORTANCE_LOW,
        )
        nm.createNotificationChannel(channel)

        val intent = act.packageManager.getLaunchIntentForPackage(act.packageName) ?: return
        val pi = PendingIntent.getActivity(
            act, REQUEST_CODE, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = Notification.Builder(act, CHANNEL_ID)
            .setContentTitle("Temple TV")
            .setContentText("Tap to return to full screen")
            .setSmallIcon(android.R.drawable.ic_menu_zoom)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setPriority(Notification.PRIORITY_LOW)
            .build()

        nm.notify(NOTIFICATION_ID, notification)
    }
}
