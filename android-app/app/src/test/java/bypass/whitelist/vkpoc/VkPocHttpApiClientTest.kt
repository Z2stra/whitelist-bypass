package bypass.whitelist.vkpoc

import bypass.whitelist.vkpoc.core.VkPocApiError
import bypass.whitelist.vkpoc.core.VkPocApiException
import bypass.whitelist.vkpoc.core.VkPocProtocol
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.net.URL
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.Principal
import java.security.cert.Certificate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

class VkPocHttpApiClientTest {
    @Test
    fun `send uses fixed HTTPS endpoint and form body without URL credentials`() = runTest {
        val connection = FakeHttpsURLConnection(responseBody = "{\"response\":321}")
        var openedUri: URI? = null
        val client = VkPocHttpApiClient(
            expectedPeerId = PEER_ID,
            accessTokenProvider = { TOKEN_CANARY },
            connectionFactory = { uri ->
                openedUri = uri
                connection
            },
        )
        val correlation = VkPocProtocol.Correlation(REQUEST_ID, NONCE)
        val ping = VkPocProtocol.formatPing(correlation)

        val messageId = client.sendMessage(PEER_ID, RANDOM_ID, ping)

        assertEquals(321L, messageId)
        assertEquals("https", openedUri?.scheme)
        assertEquals(VkPocHttpApiClient.API_HOST, openedUri?.host)
        assertEquals("/method/messages.send", openedUri?.path)
        assertNull(openedUri?.query)
        assertFalse(openedUri.toString().contains(TOKEN_CANARY))
        assertEquals("POST", connection.requestMethod)
        assertFalse(connection.instanceFollowRedirects)

        val form = decodeForm(connection.requestBody())
        assertEquals(TOKEN_CANARY, form["access_token"])
        assertEquals(VkPocHttpApiClient.API_VERSION, form["v"])
        assertEquals(PEER_ID.toString(), form["peer_id"])
        assertEquals(RANDOM_ID.toString(), form["random_id"])
        assertEquals(ping, form["message"])
    }

    @Test
    fun `history parses only the normalized fields needed by strict matcher`() = runTest {
        val response =
            """{"response":{"count":1,"items":[{"id":91,"conversation_message_id":44,"date":1700000000,"from_id":-42,"peer_id":-42,"out":0,"text":"unrelated"}]}}"""
        val connection = FakeHttpsURLConnection(responseBody = response)
        val client = client(connection)

        val history = client.getHistory(PEER_ID)

        assertEquals(1, history.size)
        with(history.single()) {
            assertEquals(91L, id)
            assertEquals(44L, conversationMessageId)
            assertEquals(1_700_000_000L, date)
            assertEquals(PEER_ID, fromId)
            assertEquals(PEER_ID, peerId)
            assertFalse(out)
            assertEquals("unrelated", text)
        }
        val form = decodeForm(connection.requestBody())
        assertEquals("200", form["count"])
        assertEquals("0", form["rev"])
        assertEquals(PEER_ID.toString(), form["peer_id"])
    }

    @Test
    fun `auth expiry validation and rate errors map to bounded enums`() = runTest {
        val cases = listOf(
            5 to VkPocApiError.AUTH_EXPIRED,
            1117 to VkPocApiError.AUTH_EXPIRED,
            14 to VkPocApiError.VALIDATION_REQUIRED,
            17 to VkPocApiError.VALIDATION_REQUIRED,
            6 to VkPocApiError.RATE_LIMITED,
            29 to VkPocApiError.RATE_LIMITED,
            901 to VkPocApiError.API_REJECTED,
        )

        cases.forEach { (code, expected) ->
            val connection = FakeHttpsURLConnection(
                responseBody = "{\"error\":{\"error_code\":$code,\"error_msg\":\"$TOKEN_CANARY\"}}",
            )
            val failure = expectApiException { client(connection).getHistory(PEER_ID) }
            assertEquals(expected, failure.error)
            assertEquals(expected.name, failure.message)
            assertFalse(failure.toString().contains(TOKEN_CANARY))
            assertNull(failure.cause)
        }
    }

    @Test
    fun `malformed response never enters the typed exception`() = runTest {
        val connection = FakeHttpsURLConnection(responseBody = "{malformed-$TOKEN_CANARY")

        val failure = expectApiException { client(connection).getHistory(PEER_ID) }

        assertEquals(VkPocApiError.MALFORMED_RESPONSE, failure.error)
        assertFalse(failure.toString().contains(TOKEN_CANARY))
        assertNull(failure.cause)
    }

    @Test
    fun `HTTP and transport failures map without response or exception details`() = runTest {
        val httpCases = listOf(
            401 to VkPocApiError.AUTH_EXPIRED,
            429 to VkPocApiError.RATE_LIMITED,
            500 to VkPocApiError.NETWORK,
            403 to VkPocApiError.API_REJECTED,
        )
        httpCases.forEach { (status, expected) ->
            val failure = expectApiException {
                client(
                    FakeHttpsURLConnection(
                        status = status,
                        responseBody = TOKEN_CANARY,
                    ),
                ).getHistory(PEER_ID)
            }
            assertEquals(expected, failure.error)
            assertFalse(failure.toString().contains(TOKEN_CANARY))
            assertNull(failure.cause)
        }

        val transportFailure = expectApiException {
            client(
                FakeHttpsURLConnection(
                    responseBody = "unused",
                    responseFailure = IOException(TOKEN_CANARY),
                ),
            ).getHistory(PEER_ID)
        }
        assertEquals(VkPocApiError.NETWORK, transportFailure.error)
        assertFalse(transportFailure.toString().contains(TOKEN_CANARY))
        assertNull(transportFailure.cause)
    }

    @Test
    fun `adapter rejects any peer or payload outside the POC allowlist`() = runTest {
        val validConnection = FakeHttpsURLConnection(responseBody = "{\"response\":1}")
        val client = client(validConnection)

        val wrongPeer = expectApiException { client.getHistory(PEER_ID - 1) }
        val wrongPayload = expectApiException {
            client.sendMessage(PEER_ID, RANDOM_ID, "not-a-ping")
        }
        val wrongRandomId = expectApiException {
            client.sendMessage(
                PEER_ID,
                0,
                VkPocProtocol.formatPing(VkPocProtocol.Correlation(REQUEST_ID, NONCE)),
            )
        }

        assertEquals(VkPocApiError.API_REJECTED, wrongPeer.error)
        assertEquals(VkPocApiError.MALFORMED_RESPONSE, wrongPayload.error)
        assertEquals(VkPocApiError.MALFORMED_RESPONSE, wrongRandomId.error)
        assertTrue(validConnection.requestBody().isEmpty())
    }

    @Test
    fun `cancellation disconnects an in-flight HTTPS call`() = runTest {
        val connection = FakeHttpsURLConnection(
            responseBody = "unused",
            blockResponseUntilDisconnect = true,
        )
        val call = launch(start = CoroutineStart.UNDISPATCHED) {
            client(connection).getHistory(PEER_ID)
        }
        assertTrue(connection.awaitResponseRead())

        call.cancel()
        call.join()

        assertTrue(call.isCancelled)
        assertTrue(connection.awaitDisconnect())
    }

    private fun client(connection: FakeHttpsURLConnection): VkPocHttpApiClient =
        VkPocHttpApiClient(
            expectedPeerId = PEER_ID,
            accessTokenProvider = { "synthetic-token" },
            connectionFactory = { connection },
        )

    private suspend fun expectApiException(block: suspend () -> Unit): VkPocApiException {
        try {
            block()
        } catch (failure: VkPocApiException) {
            return failure
        }
        fail("Expected VkPocApiException")
        throw AssertionError("unreachable")
    }

    private fun decodeForm(body: String): Map<String, String> =
        body.split('&').associate { field ->
            val separator = field.indexOf('=')
            URLDecoder.decode(field.substring(0, separator), StandardCharsets.UTF_8.name()) to
                URLDecoder.decode(field.substring(separator + 1), StandardCharsets.UTF_8.name())
        }

    private class FakeHttpsURLConnection(
        private val status: Int = 200,
        private val responseBody: String,
        private val responseFailure: IOException? = null,
        private val blockResponseUntilDisconnect: Boolean = false,
    ) : HttpsURLConnection(URL("https://api.vk.ru/")) {
        private val request = ByteArrayOutputStream()
        private val responseRead = CountDownLatch(1)
        private val disconnected = CountDownLatch(1)

        fun requestBody(): String = request.toString(StandardCharsets.UTF_8.name())

        fun awaitResponseRead(): Boolean = responseRead.await(2, TimeUnit.SECONDS)

        fun awaitDisconnect(): Boolean = disconnected.await(2, TimeUnit.SECONDS)

        override fun getOutputStream(): ByteArrayOutputStream = request

        override fun getInputStream(): InputStream =
            ByteArrayInputStream(responseBody.toByteArray(StandardCharsets.UTF_8))

        override fun getErrorStream(): InputStream? =
            if (status in 200..299) null else inputStream

        override fun getResponseCode(): Int {
            responseRead.countDown()
            if (blockResponseUntilDisconnect) {
                if (!disconnected.await(2, TimeUnit.SECONDS)) {
                    throw IOException("synthetic blocked response timeout")
                }
                throw IOException("synthetic disconnected call")
            }
            return responseFailure?.let { throw it } ?: status
        }

        override fun disconnect() {
            disconnected.countDown()
        }

        override fun usingProxy(): Boolean = false

        override fun connect() = Unit

        override fun getCipherSuite(): String = "TLS_FAKE"

        override fun getLocalCertificates(): Array<Certificate>? = null

        override fun getServerCertificates(): Array<Certificate> = emptyArray()

        override fun getPeerPrincipal(): Principal? = null

        override fun getLocalPrincipal(): Principal? = null
    }

    companion object {
        const val PEER_ID = -42L
        const val RANDOM_ID = 123_456
        const val REQUEST_ID = "req_1234567890abcd"
        const val NONCE = "nonce_1234567890abcdef"
        const val TOKEN_CANARY = "token/+ =canary?"
    }
}
