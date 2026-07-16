package bypass.whitelist.vkpoc.core

/** Normalized subset of a VK messages.getHistory item used by the POC. */
data class VkHistoryMessage(
    val id: Long,
    val conversationMessageId: Long,
    val date: Long,
    val fromId: Long,
    val peerId: Long,
    val out: Boolean,
    val text: String,
)

/**
 * Narrow official VK API boundary. Authentication remains owned by the
 * platform adapter; access and refresh tokens never cross this interface.
 */
interface VkPocApiClient {
    suspend fun getHistory(peerId: Long): List<VkHistoryMessage>

    suspend fun sendMessage(
        peerId: Long,
        randomId: Int,
        text: String,
    ): Long
}

enum class VkPocApiError {
    AUTH_EXPIRED,
    SCOPE_MISSING,
    NETWORK,
    RATE_LIMITED,
    VALIDATION_REQUIRED,
    API_REJECTED,
    MALFORMED_RESPONSE,
}

/** Adapter exception with a bounded reason. Its potentially unsafe cause is never returned to UI state. */
class VkPocApiException(
    val error: VkPocApiError,
    cause: Throwable? = null,
) : Exception(error.name, cause)

/** Token-free refresh boundary used after an official API authentication-expired response. */
interface VkPocAuthRepository {
    suspend fun refresh(): VkPocRefreshResult
}

enum class VkPocRefreshResult {
    REFRESHED,
    REAUTHENTICATION_REQUIRED,
    MESSAGES_SCOPE_MISSING,
    FAILED,
}

/** Fixed, safe-to-display failures. No adapter or server text can enter these messages. */
enum class VkPocError(
    val safeMessage: String,
) {
    INVALID_COMMUNITY_ID("VK community configuration is invalid."),
    AUTHENTICATION_REQUIRED("VK authorization is required."),
    AUTH_REFRESH_FAILED("VK authorization could not be refreshed."),
    VK_SCOPE_MISSING("VK messages permission is missing."),
    NETWORK_UNAVAILABLE("VK could not be reached. Check the network and try again."),
    RATE_LIMITED("VK temporarily limited requests. Try again later."),
    VALIDATION_REQUIRED("VK account validation is required before the POC can continue."),
    VK_API_REJECTED("VK rejected the POC request."),
    MALFORMED_RESPONSE("VK returned an invalid response."),
    UNEXPECTED("The VK POC could not be completed."),
}

sealed interface VkPocResult {
    data object Success : VkPocResult

    data object Timeout : VkPocResult

    data class Failure(
        val error: VkPocError,
    ) : VkPocResult
}

/** Token-free states that an Android presentation adapter may expose. */
sealed interface VkPocUiState {
    data object SignedOut : VkPocUiState

    data object Authorizing : VkPocUiState

    data object Refreshing : VkPocUiState

    data object SigningOut : VkPocUiState

    data object Authorized : VkPocUiState

    data object Sending : VkPocUiState

    data object WaitingForPong : VkPocUiState

    data class Success(
        val elapsedMillis: Long,
    ) : VkPocUiState

    data object Timeout : VkPocUiState

    data object Cancelled : VkPocUiState

    data class Error(
        val error: VkPocError,
    ) : VkPocUiState
}
