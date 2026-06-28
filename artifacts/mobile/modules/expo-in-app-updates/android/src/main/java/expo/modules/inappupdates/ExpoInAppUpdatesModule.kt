package expo.modules.inappupdates

import android.app.Activity
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeout

class ExpoInAppUpdatesModule : Module() {

    companion object {
        private const val UPDATE_REQUEST_CODE      = 21_341
        private const val EVENT_INSTALL_STATE      = "onInstallStateUpdate"
        /** Timeout waiting for the Play dialog activity result (2 min). */
        private const val RESULT_TIMEOUT_MS        = 120_000L
    }

    private var manager: AppUpdateManager? = null
    private var installListener: InstallStateUpdatedListener? = null

    /**
     * Deferred that bridges [OnActivityResult] back to the suspended [startUpdate] call.
     * Nullable — set just before startUpdateFlowForResult and cleared on result delivery.
     */
    private var pendingResult: CompletableDeferred<Int>? = null

    private val currentActivity: Activity
        get() = appContext.activityProvider?.currentActivity
            ?: throw Exceptions.MissingActivity()

    override fun definition() = ModuleDefinition {

        Name("ExpoInAppUpdates")
        Events(EVENT_INSTALL_STATE)

        // ── Lifecycle ──────────────────────────────────────────────────────────

        OnCreate {
            try {
                val ctx = appContext.reactContext ?: return@OnCreate
                manager = AppUpdateManagerFactory.create(ctx)
            } catch (_: Exception) {
                // Google Play Services not available (sideloaded APK, emulator, etc.)
            }
        }

        OnDestroy {
            detachInstallListener()
            pendingResult?.cancel()
            pendingResult = null
            manager = null
        }

        // ── Activity result bridge ─────────────────────────────────────────────
        // Expo Modules delivers Activity.onActivityResult here.  The Play SDK
        // calls back with requestCode == UPDATE_REQUEST_CODE after the user
        // accepts or cancels the update dialog.

        OnActivityResult { _, payload ->
            if (payload.requestCode == UPDATE_REQUEST_CODE) {
                pendingResult?.complete(payload.resultCode)
                pendingResult = null
            }
        }

        // ── checkForUpdate ─────────────────────────────────────────────────────

        AsyncFunction("checkForUpdate") {
            val mgr = manager ?: return@AsyncFunction noUpdateMap()
            runBlocking {
                try {
                    val info: AppUpdateInfo = mgr.appUpdateInfo.await()
                    val avail = info.updateAvailability()

                    val isAvailable = avail == UpdateAvailability.UPDATE_AVAILABLE ||
                        avail == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS
                    val isAlreadyDownloaded = info.installStatus() == InstallStatus.DOWNLOADED

                    mapOf(
                        "isAvailable"          to isAvailable,
                        "isAlreadyDownloaded"  to isAlreadyDownloaded,
                        "allowsFlexible"       to (isAvailable && info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE)),
                        "allowsImmediate"      to (isAvailable && info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE)),
                        "staleDays"            to info.clientVersionStalenessDays(),
                        "availableVersionCode" to if (isAvailable || isAlreadyDownloaded)
                                                    info.availableVersionCode() else null,
                    )
                } catch (_: Exception) {
                    noUpdateMap()
                }
            }
        }

        // ── startUpdate ────────────────────────────────────────────────────────
        //
        // Presents the Play update dialog and suspends until the user responds.
        //
        // Return values mirror Activity result codes:
        //    0  = RESULT_OK        (user accepted / flow succeeded)
        //   -1  = RESULT_CANCELLED (user declined the dialog)
        //    1  = IN_APP_UPDATE_FAILED

        AsyncFunction("startUpdate") { updateType: Int ->
            val mgr = manager ?: return@AsyncFunction Activity.RESULT_CANCELED
            runBlocking {
                try {
                    attachInstallListener()

                    val info: AppUpdateInfo = mgr.appUpdateInfo.await()
                    val type    = if (updateType == UpdateType.IMMEDIATE) AppUpdateType.IMMEDIATE
                                  else AppUpdateType.FLEXIBLE
                    val options = AppUpdateOptions.newBuilder(type).build()

                    // Discard any stale deferred from a previous, non-completed call.
                    pendingResult?.cancel()
                    val deferred = CompletableDeferred<Int>()
                    pendingResult = deferred

                    // This starts the Play-managed activity (dialog or full-screen).
                    // The result arrives via OnActivityResult above.
                    mgr.startUpdateFlowForResult(info, currentActivity, options, UPDATE_REQUEST_CODE)

                    // Suspend until the activity result fires or we time out.
                    withTimeout(RESULT_TIMEOUT_MS) { deferred.await() }
                } catch (_: Exception) {
                    pendingResult?.cancel()
                    pendingResult = null
                    Activity.RESULT_CANCELED
                }
            }
        }

        // ── completeUpdate ─────────────────────────────────────────────────────
        // Triggers an app restart to apply a downloaded flexible update.

        AsyncFunction("completeUpdate") {
            runBlocking {
                try {
                    manager?.completeUpdate()?.await()
                } catch (_: Exception) { /* non-fatal — app restart handled by Play */ }
            }
            return@AsyncFunction null
        }

        // ── unregisterListener ─────────────────────────────────────────────────

        AsyncFunction("unregisterListener") {
            detachInstallListener()
            return@AsyncFunction null
        }
    }

    // ── Install state listener helpers ─────────────────────────────────────────

    private fun attachInstallListener() {
        val mgr = manager ?: return
        if (installListener != null) return  // idempotent

        val listener = InstallStateUpdatedListener { state ->
            val total      = state.totalBytesToDownload()
            val downloaded = state.bytesDownloaded()
            val progress   = if (total > 0L) downloaded.toDouble() / total.toDouble() else 0.0

            sendEvent(
                EVENT_INSTALL_STATE,
                mapOf(
                    "status"               to mapStatus(state.installStatus()),
                    "progress"             to progress,
                    "bytesDownloaded"      to downloaded,
                    "totalBytesToDownload" to total,
                ),
            )
        }
        installListener = listener
        mgr.registerListener(listener)
    }

    private fun detachInstallListener() {
        val listener = installListener ?: return
        manager?.unregisterListener(listener)
        installListener = null
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private fun mapStatus(status: Int): String = when (status) {
        InstallStatus.PENDING     -> "pending"
        InstallStatus.DOWNLOADING -> "downloading"
        InstallStatus.DOWNLOADED  -> "downloaded"
        InstallStatus.INSTALLING  -> "installing"
        InstallStatus.INSTALLED   -> "installed"
        InstallStatus.FAILED      -> "failed"
        InstallStatus.CANCELED    -> "cancelled"
        else                      -> "unknown"
    }

    private fun noUpdateMap() = mapOf(
        "isAvailable"          to false,
        "isAlreadyDownloaded"  to false,
        "allowsFlexible"       to false,
        "allowsImmediate"      to false,
        "staleDays"            to null,
        "availableVersionCode" to null,
    )

    // Expose UpdateType constants so the JS side can reference them symbolically.
    private object UpdateType {
        const val FLEXIBLE  = 0
        const val IMMEDIATE = 1
    }
}
