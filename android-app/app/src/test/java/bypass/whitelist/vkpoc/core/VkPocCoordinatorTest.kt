package bypass.whitelist.vkpoc.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VkPocCoordinatorTest {
    @Test
    fun `captures max baseline before send and accepts exact newer incoming PONG`() = runTest {
        val events = mutableListOf<String>()
        val api = FakeApi().apply {
            historyHandler = { call, peerId ->
                events += "history:$call:$peerId"
                when (call) {
                    0 -> listOf(historyMessage(4), historyMessage(BASELINE))
                    else -> listOf(exactPong(BASELINE + 1))
                }
            }
            sendHandler = { peerId, randomId, text ->
                events += "send:$peerId:$randomId:$text"
                77L
            }
        }
        val waitingTimes = mutableListOf<Long>()

        val result = coordinator(api).run(GROUP_ID) {
            events += "waiting"
            waitingTimes += testScheduler.currentTime
        }

        assertSame(VkPocResult.Success, result)
        assertEquals(1_000L, testScheduler.currentTime)
        assertEquals(listOf(0L), waitingTimes)
        assertEquals(
            listOf(
                "history:0:$PEER_ID",
                "send:$PEER_ID:$RANDOM_ID:${VkPocProtocol.formatPing(CORRELATION)}",
                "waiting",
                "history:1:$PEER_ID",
            ),
            events,
        )
        assertTrue(api.sent.single().randomId > 0)
        assertEquals(CORRELATION, VkPocProtocol.parsePing(api.sent.single().text))
    }

    @Test
    fun `stale exact PONG is rejected`() = assertCandidatesRejected { _, baseline, _ ->
        listOf(exactPong(baseline))
    }

    @Test
    fun `wrong peer PONG is rejected`() = assertCandidatesRejected { _, baseline, peerId ->
        listOf(exactPong(baseline + 1).copy(peerId = peerId - 1))
    }

    @Test
    fun `wrong sender PONG is rejected`() = assertCandidatesRejected { _, baseline, peerId ->
        listOf(exactPong(baseline + 1).copy(fromId = peerId - 1))
    }

    @Test
    fun `outgoing PONG is rejected`() = assertCandidatesRejected { _, baseline, _ ->
        listOf(exactPong(baseline + 1).copy(out = true))
    }

    @Test
    fun `malformed PONG is rejected`() = assertCandidatesRejected { _, baseline, _ ->
        listOf(
            exactPong(baseline + 1).copy(
                text = "WLB-POC/1  PONG ${CORRELATION.requestId} ${CORRELATION.nonce}",
            ),
        )
    }

    @Test
    fun `wrong request or nonce pair is rejected`() = assertCandidatesRejected { _, baseline, _ ->
        listOf(
            exactPong(baseline + 1).copy(
                text = VkPocProtocol.formatPong(CORRELATION.copy(requestId = OTHER_REQUEST_ID)),
            ),
            exactPong(baseline + 2).copy(
                text = VkPocProtocol.formatPong(CORRELATION.copy(nonce = OTHER_NONCE)),
            ),
        )
    }

    @Test
    fun `timeout is bounded to 60 seconds with required polling cadence`() = runTest {
        val pollTimes = mutableListOf<Long>()
        val api = FakeApi().apply {
            historyHandler = { call, _ ->
                if (call > 0) pollTimes += testScheduler.currentTime
                emptyList()
            }
        }

        val result = coordinator(api).run(GROUP_ID)

        assertSame(VkPocResult.Timeout, result)
        assertEquals(VkPocCoordinator.POLL_DEADLINE_MILLIS, testScheduler.currentTime)
        val expectedPollTimes =
            (1_000L..10_000L step 1_000L).toList() +
                (12_000L..30_000L step 2_000L).toList() +
                (34_000L..58_000L step 4_000L).toList()
        assertEquals(expectedPollTimes, pollTimes)
    }

    @Test
    fun `external coroutine cancellation stops polling and propagates`() = runTest {
        val api = FakeApi()
        var returnedNormally = false
        val job = launch {
            coordinator(api).run(GROUP_ID)
            returnedNormally = true
        }

        runCurrent()
        assertEquals(1, api.historyCalls)
        assertEquals(1, api.sent.size)

        job.cancel()
        job.join()

        assertTrue(job.isCancelled)
        assertFalse(returnedNormally)
        assertEquals(1, api.historyCalls)
    }

    @Test
    fun `auth expiry refreshes and retries the failed operation once`() = runTest {
        val auth = FakeAuthRepository()
        val events = mutableListOf<String>()
        auth.onRefresh = {
            events += "refresh"
            VkPocRefreshResult.REFRESHED
        }
        val api = FakeApi().apply {
            historyHandler = { call, _ ->
                events += "history:$call"
                when (call) {
                    0 -> throw VkPocApiException(VkPocApiError.AUTH_EXPIRED)
                    1 -> emptyList()
                    else -> listOf(exactPong(BASELINE + 1))
                }
            }
            sendHandler = { _, _, _ ->
                events += "send"
                1L
            }
        }

        val result = coordinator(api, auth).run(GROUP_ID)

        assertSame(VkPocResult.Success, result)
        assertEquals(1, auth.refreshCalls)
        assertEquals(listOf("history:0", "refresh", "history:1", "send", "history:2"), events)
    }

    @Test
    fun `send auth retry reuses the exact PING and positive random id`() = runTest {
        val auth = FakeAuthRepository()
        var sendAttempts = 0
        val api = FakeApi().apply {
            historyHandler = { call, _ ->
                if (call == 0) emptyList() else listOf(exactPong(BASELINE + 1))
            }
            sendHandler = { _, _, _ ->
                sendAttempts += 1
                if (sendAttempts == 1) throw VkPocApiException(VkPocApiError.AUTH_EXPIRED)
                9L
            }
        }

        val result = coordinator(api, auth).run(GROUP_ID)

        assertSame(VkPocResult.Success, result)
        assertEquals(1, auth.refreshCalls)
        assertEquals(2, api.sent.size)
        assertEquals(api.sent[0], api.sent[1])
        assertTrue(api.sent[0].randomId > 0)
        assertEquals(CORRELATION, VkPocProtocol.parsePing(api.sent[0].text))
    }

    @Test
    fun `second auth expiry is not refreshed again`() = runTest {
        val auth = FakeAuthRepository()
        val api = FakeApi().apply {
            historyHandler = { _, _ -> throw VkPocApiException(VkPocApiError.AUTH_EXPIRED) }
        }

        val result = coordinator(api, auth).run(GROUP_ID)

        assertEquals(VkPocResult.Failure(VkPocError.AUTHENTICATION_REQUIRED), result)
        assertEquals(1, auth.refreshCalls)
        assertEquals(2, api.historyCalls)
        assertTrue(api.sent.isEmpty())
    }

    @Test
    fun `waiting callback failure cannot abort delivered PING or expose details`() = runTest {
        val syntheticSecret = "synthetic-access-canary"
        val api = FakeApi().apply {
            historyHandler = { call, _ ->
                if (call == 0) emptyList() else listOf(exactPong(BASELINE + 1))
            }
        }

        val result = coordinator(api).run(GROUP_ID) {
            throw IllegalStateException(syntheticSecret)
        }

        assertSame(VkPocResult.Success, result)
        assertFalse(result.toString().contains(syntheticSecret))
    }

    @Test
    fun `arbitrary adapter errors are reduced to token-free UI-safe errors`() = runTest {
        val syntheticSecret = "synthetic-access-canary"
        val api = FakeApi().apply {
            historyHandler = { _, _ ->
                throw VkPocApiException(
                    VkPocApiError.NETWORK,
                    IllegalStateException(syntheticSecret),
                )
            }
        }

        val result = coordinator(api).run(GROUP_ID)

        val expected = VkPocResult.Failure(VkPocError.NETWORK_UNAVAILABLE)
        assertEquals(expected, result)
        val displayable = "$result ${(result as VkPocResult.Failure).error.safeMessage}"
        assertFalse(displayable.contains(syntheticSecret))
        assertFalse(VkPocUiState.Error(result.error).toString().contains(syntheticSecret))
    }

    @Test
    fun `raw unexpected exception text is never surfaced`() = runTest {
        val syntheticSecret = "synthetic-refresh-canary"
        val api = FakeApi().apply {
            historyHandler = { _, _ -> throw IllegalStateException(syntheticSecret) }
        }

        val result = coordinator(api).run(GROUP_ID)

        assertEquals(VkPocResult.Failure(VkPocError.UNEXPECTED), result)
        assertFalse(result.toString().contains(syntheticSecret))
    }

    @Test
    fun `VK validation has a distinct safe error`() = runTest {
        val api = FakeApi().apply {
            historyHandler = { _, _ ->
                throw VkPocApiException(VkPocApiError.VALIDATION_REQUIRED)
            }
        }

        val result = coordinator(api).run(GROUP_ID)

        assertEquals(VkPocResult.Failure(VkPocError.VALIDATION_REQUIRED), result)
    }

    @Test
    fun `refresh exception is reduced to a safe fixed error`() = runTest {
        val syntheticSecret = "synthetic-refresh-canary"
        val auth = FakeAuthRepository().apply {
            onRefresh = { throw IllegalStateException(syntheticSecret) }
        }
        val api = FakeApi().apply {
            historyHandler = { _, _ -> throw VkPocApiException(VkPocApiError.AUTH_EXPIRED) }
        }

        val result = coordinator(api, auth).run(GROUP_ID)

        assertEquals(VkPocResult.Failure(VkPocError.AUTH_REFRESH_FAILED), result)
        val displayable = "$result ${(result as VkPocResult.Failure).error.safeMessage}"
        assertFalse(displayable.contains(syntheticSecret))
    }

    @Test
    fun `invalid group id fails before entropy auth or API use`() = runTest {
        val api = FakeApi()
        val auth = FakeAuthRepository()

        val result = coordinator(api, auth).run(0)

        assertEquals(VkPocResult.Failure(VkPocError.INVALID_COMMUNITY_ID), result)
        assertEquals(0, api.historyCalls)
        assertTrue(api.sent.isEmpty())
        assertEquals(0, auth.refreshCalls)
    }

    private fun assertCandidatesRejected(
        candidates: (VkPocProtocol.Correlation, Long, Long) -> List<VkHistoryMessage>,
    ) = runTest {
        val api = FakeApi().apply {
            historyHandler = { call, _ ->
                when (call) {
                    0 -> listOf(historyMessage(BASELINE))
                    1 -> candidates(CORRELATION, BASELINE, PEER_ID)
                    else -> listOf(exactPong(BASELINE + 100))
                }
            }
        }

        val result = coordinator(api).run(GROUP_ID)

        assertSame(VkPocResult.Success, result)
        assertEquals(2_000L, testScheduler.currentTime)
        assertEquals(3, api.historyCalls)
    }

    private fun coordinator(
        api: FakeApi,
        auth: FakeAuthRepository = FakeAuthRepository(),
    ): VkPocCoordinator = VkPocCoordinator(api, auth, FixedEntropy)

    private class FakeApi : VkPocApiClient {
        var historyCalls = 0
        val sent = mutableListOf<SentMessage>()
        var historyHandler: suspend (call: Int, peerId: Long) -> List<VkHistoryMessage> =
            { _, _ -> emptyList() }
        var sendHandler: suspend (peerId: Long, randomId: Int, text: String) -> Long =
            { _, _, _ -> 1L }

        override suspend fun getHistory(peerId: Long): List<VkHistoryMessage> {
            val call = historyCalls++
            return historyHandler(call, peerId)
        }

        override suspend fun sendMessage(peerId: Long, randomId: Int, text: String): Long {
            sent += SentMessage(peerId, randomId, text)
            return sendHandler(peerId, randomId, text)
        }
    }

    private class FakeAuthRepository : VkPocAuthRepository {
        var refreshCalls = 0
        var onRefresh: suspend () -> VkPocRefreshResult = { VkPocRefreshResult.REFRESHED }

        override suspend fun refresh(): VkPocRefreshResult {
            refreshCalls += 1
            return onRefresh()
        }
    }

    private data class SentMessage(
        val peerId: Long,
        val randomId: Int,
        val text: String,
    )

    private object FixedEntropy : VkPocEntropy {
        override fun newCorrelation(): VkPocProtocol.Correlation = CORRELATION

        override fun newPositiveRandomId(): Int = RANDOM_ID
    }

    companion object {
        const val GROUP_ID = 42L
        const val PEER_ID = -GROUP_ID
        const val BASELINE = 20L
        const val RANDOM_ID = 123_456_789
        const val REQUEST_ID = "req_1234567890abcd"
        const val NONCE = "nonce_1234567890abcdef"
        const val OTHER_REQUEST_ID = "req_abcdefghij9876"
        const val OTHER_NONCE = "nonce_abcdefghijklmnop"
        val CORRELATION = VkPocProtocol.Correlation(REQUEST_ID, NONCE)

        fun historyMessage(
            conversationMessageId: Long,
            text: String = "unrelated",
        ) = VkHistoryMessage(
            id = conversationMessageId + 1_000,
            conversationMessageId = conversationMessageId,
            date = 1_700_000_000,
            fromId = PEER_ID,
            peerId = PEER_ID,
            out = false,
            text = text,
        )

        fun exactPong(conversationMessageId: Long): VkHistoryMessage =
            historyMessage(
                conversationMessageId = conversationMessageId,
                text = VkPocProtocol.formatPong(CORRELATION),
            )
    }
}
