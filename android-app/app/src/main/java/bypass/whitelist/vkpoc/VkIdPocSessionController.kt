package bypass.whitelist.vkpoc

import bypass.whitelist.vkpoc.core.VkPocApiError
import bypass.whitelist.vkpoc.core.VkPocApiException
import bypass.whitelist.vkpoc.core.VkPocRefreshResult
import com.vk.id.AccessToken
import com.vk.id.VKID
import com.vk.id.VKIDAuthFail
import com.vk.id.auth.VKIDAuthCallback
import com.vk.id.auth.VKIDAuthParams
import com.vk.id.logout.VKIDLogoutCallback
import com.vk.id.logout.VKIDLogoutFail
import com.vk.id.refresh.VKIDRefreshTokenCallback
import com.vk.id.refresh.VKIDRefreshTokenFail
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/** Official VK ID 2.7.1 adapter. The SDK owns its encrypted token storage. */
class VkIdPocSessionController(
    private val wallClockMillis: () -> Long = System::currentTimeMillis,
) : VkPocSessionController {
    override fun status(): VkPocSessionStatus = tokenStatus(VKID.instance.accessToken)

    override suspend fun authorize(): VkPocAuthorizationResult = coroutineScope {
        val result = CompletableDeferred<VkPocAuthorizationResult>()
        val request = launch {
            try {
                VKID.instance.authorize(
                    callback = object : VKIDAuthCallback {
                        override fun onAuth(accessToken: AccessToken) {
                            result.complete(accessToken.toAuthorizationResult())
                        }

                        override fun onFail(fail: VKIDAuthFail) {
                            val safeResult =
                                if (fail is VKIDAuthFail.Canceled) {
                                    VkPocAuthorizationResult.CANCELLED
                                } else {
                                    VkPocAuthorizationResult.FAILED
                                }
                            result.complete(safeResult)
                        }
                    },
                    params = VKIDAuthParams {
                        scopes = setOf(MESSAGES_SCOPE)
                    },
                )
            } catch (cancelled: CancellationException) {
                result.cancel(cancelled)
            } catch (_: Throwable) {
                result.complete(VkPocAuthorizationResult.FAILED)
            }
        }

        try {
            result.await()
        } finally {
            request.cancel()
        }
    }

    override suspend fun refresh(): VkPocRefreshResult {
        var result = VkPocRefreshResult.FAILED
        try {
            VKID.instance.refreshToken(
                callback = object : VKIDRefreshTokenCallback {
                    override fun onSuccess(token: AccessToken) {
                        result =
                            if (token.hasMessagesScope()) {
                                VkPocRefreshResult.REFRESHED
                            } else {
                                VkPocRefreshResult.MESSAGES_SCOPE_MISSING
                            }
                    }

                    override fun onFail(fail: VKIDRefreshTokenFail) {
                        result = when (fail) {
                            is VKIDRefreshTokenFail.NotAuthenticated,
                            is VKIDRefreshTokenFail.RefreshTokenExpired,
                            is VKIDRefreshTokenFail.FailedOAuthState,
                            -> VkPocRefreshResult.REAUTHENTICATION_REQUIRED

                            is VKIDRefreshTokenFail.FailedApiCall -> VkPocRefreshResult.FAILED
                        }
                    }
                },
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            result = VkPocRefreshResult.FAILED
        }
        return result
    }

    override suspend fun logout(): VkPocLogoutResult {
        var result = VkPocLogoutResult.FAILED
        try {
            VKID.instance.logout(
                callback = object : VKIDLogoutCallback {
                    override fun onSuccess() {
                        result = VkPocLogoutResult.SIGNED_OUT
                    }

                    override fun onFail(fail: VKIDLogoutFail) {
                        result = when (fail) {
                            is VKIDLogoutFail.NotAuthenticated,
                            is VKIDLogoutFail.AccessTokenTokenExpired,
                            -> VkPocLogoutResult.SIGNED_OUT

                            is VKIDLogoutFail.FailedApiCall -> VkPocLogoutResult.FAILED
                        }
                    }
                },
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            result = VkPocLogoutResult.FAILED
        }
        return result
    }

    /**
     * Internal hand-off to the HTTP adapter. Callers must use the value only as
     * a form-body field and must never retain, display, or log it.
     */
    internal fun requireMessagesAccessToken(): String {
        val accessToken = VKID.instance.accessToken
            ?: throw VkPocApiException(VkPocApiError.AUTH_EXPIRED)
        if (!accessToken.hasMessagesScope()) {
            throw VkPocApiException(VkPocApiError.SCOPE_MISSING)
        }
        if (accessToken.isExpired()) {
            throw VkPocApiException(VkPocApiError.AUTH_EXPIRED)
        }
        return accessToken.token.takeIf(String::isNotBlank)
            ?: throw VkPocApiException(VkPocApiError.AUTH_EXPIRED)
    }

    private fun tokenStatus(accessToken: AccessToken?): VkPocSessionStatus =
        when {
            accessToken == null -> VkPocSessionStatus.SIGNED_OUT
            !accessToken.hasMessagesScope() -> VkPocSessionStatus.MESSAGES_SCOPE_MISSING
            accessToken.isExpired() -> VkPocSessionStatus.ACCESS_TOKEN_EXPIRED
            else -> VkPocSessionStatus.AUTHORIZED
        }

    private fun AccessToken.toAuthorizationResult(): VkPocAuthorizationResult =
        if (hasMessagesScope()) {
            VkPocAuthorizationResult.AUTHORIZED
        } else {
            VkPocAuthorizationResult.MESSAGES_SCOPE_MISSING
        }

    private fun AccessToken.hasMessagesScope(): Boolean =
        scopes.orEmpty().contains(MESSAGES_SCOPE)

    private fun AccessToken.isExpired(): Boolean =
        expireTime != NON_EXPIRING_TOKEN && expireTime <= wallClockMillis()

    companion object {
        private const val MESSAGES_SCOPE = "messages"
        private const val NON_EXPIRING_TOKEN = -1L
    }
}
