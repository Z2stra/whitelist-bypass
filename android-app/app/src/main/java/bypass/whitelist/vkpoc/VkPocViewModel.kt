package bypass.whitelist.vkpoc

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import bypass.whitelist.vkpoc.core.VkPocCoordinator
import bypass.whitelist.vkpoc.core.VkPocError
import bypass.whitelist.vkpoc.core.VkPocRefreshResult
import bypass.whitelist.vkpoc.core.VkPocResult
import bypass.whitelist.vkpoc.core.VkPocUiState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Owns one lifecycle-safe POC operation and exposes token-free UI state. */
class VkPocViewModel(
    private val configured: Boolean,
    private val groupId: Long,
    private val sessionController: VkPocSessionController,
    private val coordinator: VkPocCoordinator,
    private val monotonicClockMillis: () -> Long,
) : ViewModel() {
    private val initialSessionStatus = readSessionStatus()
    private val mutableUiState = MutableStateFlow(initialUiState(initialSessionStatus))
    val uiState: StateFlow<VkPocUiState> = mutableUiState.asStateFlow()

    private var activeJob: Job? = null

    init {
        if (initialSessionStatus == VkPocSessionStatus.ACCESS_TOKEN_EXPIRED) {
            refresh()
        }
    }

    fun authorize() {
        if (!configured) {
            mutableUiState.value = configurationError()
            return
        }
        launchExclusive {
            mutableUiState.value = VkPocUiState.Authorizing
            mutableUiState.value = when (sessionController.authorize()) {
                VkPocAuthorizationResult.AUTHORIZED -> VkPocUiState.Authorized
                VkPocAuthorizationResult.CANCELLED -> uiStateAfterCancelledAuthorization()
                VkPocAuthorizationResult.MESSAGES_SCOPE_MISSING ->
                    VkPocUiState.Error(VkPocError.VK_SCOPE_MISSING)
                VkPocAuthorizationResult.FAILED ->
                    VkPocUiState.Error(VkPocError.AUTHENTICATION_REQUIRED)
            }
        }
    }

    fun refresh() {
        if (!configured) {
            mutableUiState.value = configurationError()
            return
        }
        launchExclusive {
            mutableUiState.value = VkPocUiState.Refreshing
            mutableUiState.value = sessionController.refresh().toUiState()
        }
    }

    fun runExchange() {
        if (!configured) {
            mutableUiState.value = configurationError()
            return
        }
        when (readSessionStatus()) {
            VkPocSessionStatus.SIGNED_OUT -> {
                mutableUiState.value = VkPocUiState.SignedOut
                return
            }
            VkPocSessionStatus.MESSAGES_SCOPE_MISSING -> {
                mutableUiState.value = VkPocUiState.Error(VkPocError.VK_SCOPE_MISSING)
                return
            }
            VkPocSessionStatus.AUTHORIZED,
            VkPocSessionStatus.ACCESS_TOKEN_EXPIRED,
            -> Unit
        }

        launchExclusive {
            mutableUiState.value = VkPocUiState.Sending
            val operationStartedAt = monotonicClockMillis()
            var pingSentAt: Long? = null
            val result = coordinator.run(groupId) {
                pingSentAt = monotonicClockMillis()
                mutableUiState.value = VkPocUiState.WaitingForPong
            }
            mutableUiState.value = when (result) {
                VkPocResult.Success -> VkPocUiState.Success(
                    elapsedMillis =
                        (monotonicClockMillis() - (pingSentAt ?: operationStartedAt))
                            .coerceAtLeast(0L),
                )
                VkPocResult.Timeout -> VkPocUiState.Timeout
                is VkPocResult.Failure -> VkPocUiState.Error(result.error)
            }
        }
    }

    fun cancelExchange() {
        if (mutableUiState.value !is VkPocUiState.Sending &&
            mutableUiState.value !is VkPocUiState.WaitingForPong
        ) {
            return
        }
        val job = activeJob ?: return
        activeJob = null
        mutableUiState.value = VkPocUiState.Cancelled
        job.cancel()
    }

    fun logout() {
        if (!configured) {
            mutableUiState.value = configurationError()
            return
        }
        cancelActiveJob()
        launchExclusive {
            mutableUiState.value = VkPocUiState.SigningOut
            mutableUiState.value = when (sessionController.logout()) {
                VkPocLogoutResult.SIGNED_OUT -> VkPocUiState.SignedOut
                VkPocLogoutResult.FAILED -> VkPocUiState.Error(VkPocError.UNEXPECTED)
            }
        }
    }

    private fun launchExclusive(block: suspend () -> Unit) {
        if (activeJob?.isActive == true) return
        lateinit var job: Job
        job = viewModelScope.launch(start = CoroutineStart.LAZY) {
            try {
                block()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                mutableUiState.value = VkPocUiState.Error(VkPocError.UNEXPECTED)
            } finally {
                if (activeJob === job) activeJob = null
            }
        }
        activeJob = job
        job.start()
    }

    private fun cancelActiveJob() {
        val job = activeJob
        activeJob = null
        job?.cancel()
    }

    private fun readSessionStatus(): VkPocSessionStatus {
        if (!configured || groupId <= 0L) return VkPocSessionStatus.SIGNED_OUT
        return try {
            sessionController.status()
        } catch (_: Throwable) {
            VkPocSessionStatus.SIGNED_OUT
        }
    }

    private fun initialUiState(status: VkPocSessionStatus): VkPocUiState =
        when {
            !configured || groupId <= 0L -> configurationError()
            status == VkPocSessionStatus.SIGNED_OUT -> VkPocUiState.SignedOut
            status == VkPocSessionStatus.MESSAGES_SCOPE_MISSING ->
                VkPocUiState.Error(VkPocError.VK_SCOPE_MISSING)
            else -> VkPocUiState.Authorized
        }

    private fun uiStateAfterCancelledAuthorization(): VkPocUiState =
        when (readSessionStatus()) {
            VkPocSessionStatus.SIGNED_OUT -> VkPocUiState.SignedOut
            VkPocSessionStatus.AUTHORIZED -> VkPocUiState.Authorized
            VkPocSessionStatus.ACCESS_TOKEN_EXPIRED ->
                VkPocUiState.Error(VkPocError.AUTHENTICATION_REQUIRED)
            VkPocSessionStatus.MESSAGES_SCOPE_MISSING ->
                VkPocUiState.Error(VkPocError.VK_SCOPE_MISSING)
        }

    private fun VkPocRefreshResult.toUiState(): VkPocUiState =
        when (this) {
            VkPocRefreshResult.REFRESHED -> VkPocUiState.Authorized
            VkPocRefreshResult.REAUTHENTICATION_REQUIRED ->
                VkPocUiState.Error(VkPocError.AUTHENTICATION_REQUIRED)
            VkPocRefreshResult.MESSAGES_SCOPE_MISSING ->
                VkPocUiState.Error(VkPocError.VK_SCOPE_MISSING)
            VkPocRefreshResult.FAILED -> VkPocUiState.Error(VkPocError.AUTH_REFRESH_FAILED)
        }

    private fun configurationError(): VkPocUiState.Error =
        VkPocUiState.Error(VkPocError.INVALID_COMMUNITY_ID)
}
