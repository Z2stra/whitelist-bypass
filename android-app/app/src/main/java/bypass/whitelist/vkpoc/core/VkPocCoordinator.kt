package bypass.whitelist.vkpoc.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Runs one isolated official VK API PING/PONG exchange.
 *
 * Cancellation is deliberately propagated so callers retain structured
 * coroutine cancellation and can map it to [VkPocUiState.Cancelled].
 */
class VkPocCoordinator(
    private val apiClient: VkPocApiClient,
    private val authRepository: VkPocAuthRepository,
    private val entropy: VkPocEntropy = SecureVkPocEntropy(),
) {
    suspend fun run(
        groupId: Long,
        onWaitingForPong: () -> Unit = {},
    ): VkPocResult {
        if (groupId <= 0L) return VkPocResult.Failure(VkPocError.INVALID_COMMUNITY_ID)

        val peerId = -groupId
        val authRetry = SingleAuthRefreshRetry(authRepository)

        return try {
            // The maximum conversation_message_id must be captured before PING is sent.
            val baseline = authRetry.execute {
                apiClient.getHistory(peerId)
            }.maxOfOrNull(VkHistoryMessage::conversationMessageId) ?: EMPTY_BASELINE

            val correlation = entropy.newCorrelation()
            val ping = VkPocProtocol.formatPing(correlation)
            val randomId = entropy.newPositiveRandomId()
            check(randomId > 0) { "VkPocEntropy returned a non-positive random_id" }

            authRetry.execute {
                apiClient.sendMessage(
                    peerId = peerId,
                    randomId = randomId,
                    text = ping,
                )
            }
            notifyWaitingForPong(onWaitingForPong)

            val matched = withTimeoutOrNull(POLL_DEADLINE_MILLIS) {
                pollForExactPong(
                    peerId = peerId,
                    baseline = baseline,
                    correlation = correlation,
                    authRetry = authRetry,
                )
            } ?: false

            if (matched) VkPocResult.Success else VkPocResult.Timeout
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (terminal: TerminalPocException) {
            VkPocResult.Failure(terminal.error)
        } catch (apiError: VkPocApiException) {
            VkPocResult.Failure(apiError.error.toSafeError())
        } catch (_: Throwable) {
            // Never surface arbitrary exception text: SDK/server errors can contain tokens or URLs.
            VkPocResult.Failure(VkPocError.UNEXPECTED)
        }
    }

    private fun notifyWaitingForPong(callback: () -> Unit) {
        try {
            // Synchronous boundary: PING has succeeded and no polling delay has begun yet.
            callback()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // A presentation callback must not abort correlation after PING was delivered.
        }
    }

    private suspend fun pollForExactPong(
        peerId: Long,
        baseline: Long,
        correlation: VkPocProtocol.Correlation,
        authRetry: SingleAuthRefreshRetry,
    ): Boolean {
        var scheduledElapsedMillis = 0L
        while (true) {
            val interval = pollIntervalAt(scheduledElapsedMillis)
            delay(interval)
            scheduledElapsedMillis += interval

            val history = authRetry.execute {
                apiClient.getHistory(peerId)
            }
            if (history.any { message ->
                    message.conversationMessageId > baseline &&
                        !message.out &&
                        message.fromId == peerId &&
                        message.peerId == peerId &&
                        VkPocProtocol.isExactPong(message.text, correlation)
                }
            ) {
                return true
            }
        }
    }

    private fun pollIntervalAt(elapsedMillis: Long): Long =
        when {
            elapsedMillis < FIRST_POLL_WINDOW_MILLIS -> FIRST_POLL_INTERVAL_MILLIS
            elapsedMillis < SECOND_POLL_WINDOW_MILLIS -> SECOND_POLL_INTERVAL_MILLIS
            else -> FINAL_POLL_INTERVAL_MILLIS
        }

    private class SingleAuthRefreshRetry(
        private val authRepository: VkPocAuthRepository,
    ) {
        private var refreshUsed = false

        suspend fun <T> execute(operation: suspend () -> T): T {
            try {
                return operation()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: VkPocApiException) {
                if (error.error != VkPocApiError.AUTH_EXPIRED || refreshUsed) throw error
            }

            refreshUsed = true
            val refreshResult = try {
                authRepository.refresh()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                throw TerminalPocException(VkPocError.AUTH_REFRESH_FAILED)
            }

            when (refreshResult) {
                VkPocRefreshResult.REFRESHED -> Unit
                VkPocRefreshResult.REAUTHENTICATION_REQUIRED ->
                    throw TerminalPocException(VkPocError.AUTHENTICATION_REQUIRED)
                VkPocRefreshResult.MESSAGES_SCOPE_MISSING ->
                    throw TerminalPocException(VkPocError.VK_SCOPE_MISSING)
                VkPocRefreshResult.FAILED ->
                    throw TerminalPocException(VkPocError.AUTH_REFRESH_FAILED)
            }

            return operation()
        }
    }

    private class TerminalPocException(
        val error: VkPocError,
    ) : Exception(error.name)

    private fun VkPocApiError.toSafeError(): VkPocError =
        when (this) {
            VkPocApiError.AUTH_EXPIRED -> VkPocError.AUTHENTICATION_REQUIRED
            VkPocApiError.SCOPE_MISSING -> VkPocError.VK_SCOPE_MISSING
            VkPocApiError.NETWORK -> VkPocError.NETWORK_UNAVAILABLE
            VkPocApiError.RATE_LIMITED -> VkPocError.RATE_LIMITED
            VkPocApiError.VALIDATION_REQUIRED -> VkPocError.VALIDATION_REQUIRED
            VkPocApiError.API_REJECTED -> VkPocError.VK_API_REJECTED
            VkPocApiError.MALFORMED_RESPONSE -> VkPocError.MALFORMED_RESPONSE
        }

    companion object {
        const val POLL_DEADLINE_MILLIS = 60_000L
        const val FIRST_POLL_WINDOW_MILLIS = 10_000L
        const val SECOND_POLL_WINDOW_MILLIS = 30_000L
        const val FIRST_POLL_INTERVAL_MILLIS = 1_000L
        const val SECOND_POLL_INTERVAL_MILLIS = 2_000L
        const val FINAL_POLL_INTERVAL_MILLIS = 4_000L

        private const val EMPTY_BASELINE = 0L
    }
}
