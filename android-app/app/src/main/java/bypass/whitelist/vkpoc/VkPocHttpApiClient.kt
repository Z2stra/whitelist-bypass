package bypass.whitelist.vkpoc

import bypass.whitelist.vkpoc.core.VkHistoryMessage
import bypass.whitelist.vkpoc.core.VkPocApiClient
import bypass.whitelist.vkpoc.core.VkPocApiError
import bypass.whitelist.vkpoc.core.VkPocApiException
import bypass.whitelist.vkpoc.core.VkPocProtocol
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HttpsURLConnection
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Minimal allowlisted VK API transport for the POC. It only POSTs form bodies
 * to messages.send/messages.getHistory and never places a token in a URL.
 */
class VkPocHttpApiClient(
    private val expectedPeerId: Long,
    private val accessTokenProvider: () -> String,
    private val connectionFactory: (URI) -> HttpsURLConnection = { uri ->
        uri.toURL().openConnection() as HttpsURLConnection
    },
) : VkPocApiClient {
    override suspend fun getHistory(peerId: Long): List<VkHistoryMessage> {
        requireExpectedPeer(peerId)
        val response = post(
            method = METHOD_GET_HISTORY,
            parameters = linkedMapOf(
                "peer_id" to peerId.toString(),
                "count" to HISTORY_PAGE_SIZE.toString(),
                "rev" to NEWEST_FIRST,
            ),
        )
        return parseHistory(response)
    }

    override suspend fun sendMessage(peerId: Long, randomId: Int, text: String): Long {
        requireExpectedPeer(peerId)
        if (randomId <= 0 || VkPocProtocol.parsePing(text) == null) {
            throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
        }
        val response = post(
            method = METHOD_SEND,
            parameters = linkedMapOf(
                "peer_id" to peerId.toString(),
                "random_id" to randomId.toString(),
                "message" to text,
            ),
        )
        return parseSendResult(response)
    }

    private suspend fun post(
        method: String,
        parameters: LinkedHashMap<String, String>,
    ): JsonElement {
        val endpoint = ENDPOINTS[method]
            ?: throw VkPocApiException(VkPocApiError.API_REJECTED)
        val token = try {
            accessTokenProvider()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (typed: VkPocApiException) {
            throw typed
        } catch (_: Throwable) {
            throw VkPocApiException(VkPocApiError.AUTH_EXPIRED)
        }

        val form = LinkedHashMap(parameters).apply {
            put("v", API_VERSION)
            put("access_token", token)
        }
        val body = encodeForm(form).toByteArray(StandardCharsets.UTF_8)
        return suspendCancellableCoroutine { continuation ->
            val activeConnection = AtomicReference<HttpsURLConnection?>(null)
            continuation.invokeOnCancellation {
                try {
                    activeConnection.get()?.disconnect()
                } catch (_: Throwable) {
                    // Cancellation must remain token-free and must not be replaced by transport cleanup.
                }
            }

            Dispatchers.IO.dispatch(continuation.context, Runnable {
                var connection: HttpsURLConnection? = null
                try {
                    if (!continuation.isActive) return@Runnable
                    connection = connectionFactory(endpoint).apply {
                        requestMethod = "POST"
                        instanceFollowRedirects = false
                        connectTimeout = CONNECT_TIMEOUT_MILLIS
                        readTimeout = READ_TIMEOUT_MILLIS
                        doInput = true
                        doOutput = true
                        useCaches = false
                        setRequestProperty("Accept", "application/json")
                        setRequestProperty(
                            "Content-Type",
                            "application/x-www-form-urlencoded; charset=UTF-8",
                        )
                        setFixedLengthStreamingMode(body.size)
                    }
                    activeConnection.set(connection)
                    if (!continuation.isActive) return@Runnable

                    connection.outputStream.use { output -> output.write(body) }
                    val status = connection.responseCode
                    val stream =
                        if (status in HTTP_SUCCESS_RANGE) {
                            connection.inputStream
                        } else {
                            connection.errorStream
                        }
                    val responseBody = stream?.use(::readBoundedUtf8).orEmpty()

                    if (status !in HTTP_SUCCESS_RANGE) {
                        throw VkPocApiException(status.toApiError())
                    }
                    val result = parseEnvelope(responseBody)
                    continuation.resume(result)
                } catch (cancelled: CancellationException) {
                    continuation.cancel(cancelled)
                } catch (typed: VkPocApiException) {
                    continuation.resumeWithException(typed)
                } catch (_: IOException) {
                    continuation.resumeWithException(VkPocApiException(VkPocApiError.NETWORK))
                } catch (_: Throwable) {
                    continuation.resumeWithException(
                        VkPocApiException(VkPocApiError.MALFORMED_RESPONSE),
                    )
                } finally {
                    body.fill(0)
                    try {
                        connection?.disconnect()
                    } catch (_: Throwable) {
                        // Cleanup failures never cross the redacted API boundary.
                    }
                    activeConnection.compareAndSet(connection, null)
                }
            })
        }
    }

    private fun parseEnvelope(body: String): JsonElement {
        if (body.isBlank()) throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
        val root = JsonParser.parseString(body).asObjectOrMalformed()
        root.get("error")?.let { errorElement ->
            val error = errorElement.asObjectOrMalformed()
            val code = error.requiredLong("error_code")
            throw VkPocApiException(code.toApiError())
        }
        return root.get("response")
            ?: throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
    }

    private fun parseHistory(response: JsonElement): List<VkHistoryMessage> {
        val responseObject = response.asObjectOrMalformed()
        val items = responseObject.get("items")
            ?.takeIf(JsonElement::isJsonArray)
            ?.asJsonArray
            ?: throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)

        return items.map { element ->
            val message = element.asObjectOrMalformed()
            VkHistoryMessage(
                id = message.requiredLong("id"),
                conversationMessageId = message.requiredLong("conversation_message_id"),
                date = message.requiredLong("date"),
                fromId = message.requiredLong("from_id"),
                peerId = message.requiredLong("peer_id"),
                out = message.requiredBoolean("out"),
                text = message.requiredString("text"),
            )
        }
    }

    private fun parseSendResult(response: JsonElement): Long {
        if (!response.isJsonPrimitive || !response.asJsonPrimitive.isNumber) {
            throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
        }
        return try {
            response.asLong.takeIf { it > 0L }
                ?: throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
        } catch (typed: VkPocApiException) {
            throw typed
        } catch (_: Throwable) {
            throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
        }
    }

    private fun requireExpectedPeer(peerId: Long) {
        if (expectedPeerId >= 0L || peerId != expectedPeerId) {
            throw VkPocApiException(VkPocApiError.API_REJECTED)
        }
    }

    private fun readBoundedUtf8(stream: InputStream): String {
        val declaredSize = stream.available()
        if (declaredSize > MAX_RESPONSE_BYTES) {
            throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
        }

        val output = ByteArrayOutputStream(minOf(declaredSize.coerceAtLeast(0), MAX_RESPONSE_BYTES))
        val buffer = ByteArray(READ_BUFFER_BYTES)
        var total = 0
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            total += count
            if (total > MAX_RESPONSE_BYTES) {
                throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
            }
            output.write(buffer, 0, count)
        }
        return output.toString(StandardCharsets.UTF_8.name())
    }

    private fun encodeForm(parameters: LinkedHashMap<String, String>): String =
        parameters.entries.joinToString("&") { (key, value) ->
            "${formEncode(key)}=${formEncode(value)}"
        }

    private fun formEncode(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name())

    private fun JsonElement.asObjectOrMalformed(): JsonObject =
        takeIf(JsonElement::isJsonObject)?.asJsonObject
            ?: throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)

    private fun JsonObject.requiredLong(name: String): Long {
        val element = get(name)
            ?.takeIf(JsonElement::isJsonPrimitive)
            ?.asJsonPrimitive
            ?.takeIf { it.isNumber }
            ?: throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
        return try {
            element.asLong
        } catch (_: Throwable) {
            throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
        }
    }

    private fun JsonObject.requiredString(name: String): String {
        val element = get(name)
            ?.takeIf(JsonElement::isJsonPrimitive)
            ?.asJsonPrimitive
            ?.takeIf { it.isString }
            ?: throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
        return element.asString
    }

    private fun JsonObject.requiredBoolean(name: String): Boolean {
        val primitive = get(name)
            ?.takeIf(JsonElement::isJsonPrimitive)
            ?.asJsonPrimitive
            ?: throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
        return when {
            primitive.isBoolean -> primitive.asBoolean
            primitive.isNumber -> try {
                when (primitive.asInt) {
                    0 -> false
                    1 -> true
                    else -> throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
                }
            } catch (typed: VkPocApiException) {
                throw typed
            } catch (_: Throwable) {
                throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
            }
            else -> throw VkPocApiException(VkPocApiError.MALFORMED_RESPONSE)
        }
    }

    private fun Long.toApiError(): VkPocApiError =
        when (this) {
            VK_ERROR_USER_AUTHORIZATION_FAILED,
            VK_ERROR_ACCESS_TOKEN_EXPIRED,
            -> VkPocApiError.AUTH_EXPIRED

            VK_ERROR_TOO_MANY_REQUESTS,
            VK_ERROR_FLOOD_CONTROL,
            VK_ERROR_RATE_LIMIT_REACHED,
            -> VkPocApiError.RATE_LIMITED

            VK_ERROR_CAPTCHA,
            VK_ERROR_VALIDATION_REQUIRED,
            -> VkPocApiError.VALIDATION_REQUIRED

            else -> VkPocApiError.API_REJECTED
        }

    private fun Int.toApiError(): VkPocApiError =
        when {
            this == HttpURLConnection.HTTP_UNAUTHORIZED -> VkPocApiError.AUTH_EXPIRED
            this == HTTP_TOO_MANY_REQUESTS -> VkPocApiError.RATE_LIMITED
            this >= HTTP_SERVER_ERROR_MIN -> VkPocApiError.NETWORK
            else -> VkPocApiError.API_REJECTED
        }

    companion object {
        internal const val API_VERSION = "5.131"
        internal const val API_HOST = "api.vk.ru"

        private const val METHOD_SEND = "messages.send"
        private const val METHOD_GET_HISTORY = "messages.getHistory"
        private const val HISTORY_PAGE_SIZE = 200
        private const val NEWEST_FIRST = "0"
        private const val CONNECT_TIMEOUT_MILLIS = 10_000
        private const val READ_TIMEOUT_MILLIS = 15_000
        private const val MAX_RESPONSE_BYTES = 256 * 1024
        private const val READ_BUFFER_BYTES = 8 * 1024
        private const val HTTP_TOO_MANY_REQUESTS = 429
        private const val HTTP_SERVER_ERROR_MIN = 500
        private val HTTP_SUCCESS_RANGE = 200..299

        private const val VK_ERROR_USER_AUTHORIZATION_FAILED = 5L
        private const val VK_ERROR_TOO_MANY_REQUESTS = 6L
        private const val VK_ERROR_FLOOD_CONTROL = 9L
        private const val VK_ERROR_CAPTCHA = 14L
        private const val VK_ERROR_VALIDATION_REQUIRED = 17L
        private const val VK_ERROR_RATE_LIMIT_REACHED = 29L
        private const val VK_ERROR_ACCESS_TOKEN_EXPIRED = 1117L

        private val ENDPOINTS = mapOf(
            METHOD_SEND to URI("https://$API_HOST/method/$METHOD_SEND"),
            METHOD_GET_HISTORY to URI("https://$API_HOST/method/$METHOD_GET_HISTORY"),
        )
    }
}
