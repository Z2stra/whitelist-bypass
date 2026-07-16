package bypass.whitelist.vkpoc

import bypass.whitelist.vkpoc.core.VkPocAuthRepository

/** Token-free session snapshot used by the POC presentation layer. */
enum class VkPocSessionStatus {
    SIGNED_OUT,
    AUTHORIZED,
    ACCESS_TOKEN_EXPIRED,
    MESSAGES_SCOPE_MISSING,
}

enum class VkPocAuthorizationResult {
    AUTHORIZED,
    CANCELLED,
    MESSAGES_SCOPE_MISSING,
    FAILED,
}

enum class VkPocLogoutResult {
    SIGNED_OUT,
    FAILED,
}

/**
 * VK ID session boundary for the screen and ViewModel. Access and refresh
 * token values deliberately do not appear in this contract.
 */
interface VkPocSessionController : VkPocAuthRepository {
    fun status(): VkPocSessionStatus

    suspend fun authorize(): VkPocAuthorizationResult

    suspend fun logout(): VkPocLogoutResult
}
