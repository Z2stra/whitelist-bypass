package bypass.whitelist.vkpoc

import bypass.whitelist.vkpoc.core.VkHistoryMessage
import bypass.whitelist.vkpoc.core.VkPocApiClient
import bypass.whitelist.vkpoc.core.VkPocCoordinator
import bypass.whitelist.vkpoc.core.VkPocEntropy
import bypass.whitelist.vkpoc.core.VkPocError
import bypass.whitelist.vkpoc.core.VkPocProtocol
import bypass.whitelist.vkpoc.core.VkPocRefreshResult
import bypass.whitelist.vkpoc.core.VkPocUiState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description

@OptIn(ExperimentalCoroutinesApi::class)
class VkPocViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun `login requests a token-free authorized state and rejects missing scope`() =
        runTest(mainDispatcherRule.dispatcher) {
            val session = FakeSession(currentStatus = VkPocSessionStatus.SIGNED_OUT)
            val viewModel = viewModel(session = session)

            viewModel.authorize()
            advanceUntilIdle()

            assertSame(VkPocUiState.Authorized, viewModel.uiState.value)
            assertEquals(1, session.authorizeCalls)

            session.authorizationResult = VkPocAuthorizationResult.MESSAGES_SCOPE_MISSING
            viewModel.logout()
            advanceUntilIdle()
            viewModel.authorize()
            advanceUntilIdle()

            assertEquals(
                VkPocUiState.Error(VkPocError.VK_SCOPE_MISSING),
                viewModel.uiState.value,
            )
        }

    @Test
    fun `expired startup session refreshes without exposing a token`() =
        runTest(mainDispatcherRule.dispatcher) {
            val session = FakeSession(currentStatus = VkPocSessionStatus.ACCESS_TOKEN_EXPIRED)

            val viewModel = viewModel(session = session)
            advanceUntilIdle()

            assertEquals(1, session.refreshCalls)
            assertSame(VkPocUiState.Authorized, viewModel.uiState.value)
            assertFalse(viewModel.uiState.value.toString().contains(TOKEN_CANARY))
        }

    @Test
    fun `cancelled login rechecks and keeps retained expired session actionable`() =
        runTest(mainDispatcherRule.dispatcher) {
            val session = FakeSession(currentStatus = VkPocSessionStatus.SIGNED_OUT).apply {
                authorizationResult = VkPocAuthorizationResult.CANCELLED
                statusAfterAuthorization = VkPocSessionStatus.ACCESS_TOKEN_EXPIRED
            }
            val viewModel = viewModel(session = session)

            viewModel.authorize()
            advanceUntilIdle()

            assertEquals(
                VkPocUiState.Error(VkPocError.AUTHENTICATION_REQUIRED),
                viewModel.uiState.value,
            )
            assertTrue(session.tokenPresent)
            assertFalse(viewModel.uiState.value.toString().contains(TOKEN_CANARY))
        }

    @Test
    fun `exchange publishes waiting then safe latency-only success`() =
        runTest(mainDispatcherRule.dispatcher) {
            val api = FakeApi(autoPong = true)
            val viewModel = viewModel(api = api)

            viewModel.runExchange()
            runCurrent()

            assertSame(VkPocUiState.WaitingForPong, viewModel.uiState.value)
            assertEquals(1, api.historyCalls)
            assertEquals(1, api.sendCalls)

            advanceUntilIdle()

            assertEquals(VkPocUiState.Success(1_000L), viewModel.uiState.value)
            assertFalse(viewModel.uiState.value.toString().contains(api.sentText.orEmpty()))
        }

    @Test
    fun `cancel stops bounded polling and clears presentation correlation`() =
        runTest(mainDispatcherRule.dispatcher) {
            val api = FakeApi(autoPong = false)
            val viewModel = viewModel(api = api)

            viewModel.runExchange()
            runCurrent()
            assertSame(VkPocUiState.WaitingForPong, viewModel.uiState.value)

            viewModel.cancelExchange()
            advanceUntilIdle()

            assertSame(VkPocUiState.Cancelled, viewModel.uiState.value)
            assertEquals(1, api.historyCalls)
            assertFalse(viewModel.uiState.value.toString().contains(REQUEST_ID))
            assertFalse(viewModel.uiState.value.toString().contains(NONCE))
        }

    @Test
    fun `logout cancels work and clears the fake SDK-owned session`() =
        runTest(mainDispatcherRule.dispatcher) {
            val session = FakeSession(currentStatus = VkPocSessionStatus.AUTHORIZED)
            val api = FakeApi(autoPong = false)
            val viewModel = viewModel(session = session, api = api)

            viewModel.runExchange()
            runCurrent()
            viewModel.logout()
            advanceUntilIdle()

            assertSame(VkPocUiState.SignedOut, viewModel.uiState.value)
            assertEquals(1, session.logoutCalls)
            assertFalse(session.tokenPresent)
            assertNull(session.tokenCanary)
            assertFalse(viewModel.uiState.value.toString().contains(TOKEN_CANARY))
        }

    @Test
    fun `missing local configuration fails closed before any session or API call`() =
        runTest(mainDispatcherRule.dispatcher) {
            val session = FakeSession(currentStatus = VkPocSessionStatus.AUTHORIZED)
            val api = FakeApi(autoPong = true)
            val viewModel = viewModel(
                configured = false,
                session = session,
                api = api,
            )

            viewModel.authorize()
            viewModel.refresh()
            viewModel.runExchange()
            viewModel.logout()
            advanceUntilIdle()

            assertEquals(
                VkPocUiState.Error(VkPocError.INVALID_COMMUNITY_ID),
                viewModel.uiState.value,
            )
            assertEquals(0, session.authorizeCalls)
            assertEquals(0, session.refreshCalls)
            assertEquals(0, session.logoutCalls)
            assertEquals(0, api.historyCalls)
            assertEquals(0, api.sendCalls)
        }

    private fun viewModel(
        configured: Boolean = true,
        session: FakeSession = FakeSession(),
        api: FakeApi = FakeApi(autoPong = true),
    ): VkPocViewModel = VkPocViewModel(
        configured = configured,
        groupId = GROUP_ID,
        sessionController = session,
        coordinator = VkPocCoordinator(api, session, FixedEntropy),
        monotonicClockMillis = { mainDispatcherRule.dispatcher.scheduler.currentTime },
    )

    private class FakeSession(
        private var currentStatus: VkPocSessionStatus = VkPocSessionStatus.AUTHORIZED,
    ) : VkPocSessionController {
        var authorizationResult = VkPocAuthorizationResult.AUTHORIZED
        var statusAfterAuthorization: VkPocSessionStatus? = null
        var refreshResult = VkPocRefreshResult.REFRESHED
        var logoutResult = VkPocLogoutResult.SIGNED_OUT
        var authorizeCalls = 0
        var refreshCalls = 0
        var logoutCalls = 0
        var tokenPresent = currentStatus != VkPocSessionStatus.SIGNED_OUT
        var tokenCanary: String? = TOKEN_CANARY.takeIf { tokenPresent }

        override fun status(): VkPocSessionStatus = currentStatus

        override suspend fun authorize(): VkPocAuthorizationResult {
            authorizeCalls += 1
            statusAfterAuthorization?.let { status ->
                currentStatus = status
                tokenPresent = status != VkPocSessionStatus.SIGNED_OUT
                tokenCanary = TOKEN_CANARY.takeIf { tokenPresent }
            }
            if (authorizationResult == VkPocAuthorizationResult.AUTHORIZED) {
                currentStatus = VkPocSessionStatus.AUTHORIZED
                tokenPresent = true
            }
            return authorizationResult
        }

        override suspend fun refresh(): VkPocRefreshResult {
            refreshCalls += 1
            if (refreshResult == VkPocRefreshResult.REFRESHED) {
                currentStatus = VkPocSessionStatus.AUTHORIZED
            }
            return refreshResult
        }

        override suspend fun logout(): VkPocLogoutResult {
            logoutCalls += 1
            if (logoutResult == VkPocLogoutResult.SIGNED_OUT) {
                currentStatus = VkPocSessionStatus.SIGNED_OUT
                tokenPresent = false
                tokenCanary = null
            }
            return logoutResult
        }
    }

    private class FakeApi(
        private val autoPong: Boolean,
    ) : VkPocApiClient {
        var historyCalls = 0
        var sendCalls = 0
        var sentText: String? = null

        override suspend fun getHistory(peerId: Long): List<VkHistoryMessage> {
            historyCalls += 1
            val correlation = sentText?.let(VkPocProtocol::parsePing)
            if (!autoPong || correlation == null) return emptyList()
            return listOf(
                VkHistoryMessage(
                    id = 2,
                    conversationMessageId = 2,
                    date = 1_700_000_000,
                    fromId = peerId,
                    peerId = peerId,
                    out = false,
                    text = VkPocProtocol.formatPong(correlation),
                ),
            )
        }

        override suspend fun sendMessage(peerId: Long, randomId: Int, text: String): Long {
            sendCalls += 1
            sentText = text
            return 1
        }
    }

    private object FixedEntropy : VkPocEntropy {
        override fun newCorrelation(): VkPocProtocol.Correlation =
            VkPocProtocol.Correlation(REQUEST_ID, NONCE)

        override fun newPositiveRandomId(): Int = 123_456
    }

    class MainDispatcherRule(
        val dispatcher: TestDispatcher = StandardTestDispatcher(),
    ) : TestWatcher() {
        override fun starting(description: Description) {
            Dispatchers.setMain(dispatcher)
        }

        override fun finished(description: Description) {
            Dispatchers.resetMain()
        }
    }

    companion object {
        const val GROUP_ID = 42L
        const val REQUEST_ID = "req_1234567890abcd"
        const val NONCE = "nonce_1234567890abcdef"
        const val TOKEN_CANARY = "synthetic-access-token-canary"
    }
}
