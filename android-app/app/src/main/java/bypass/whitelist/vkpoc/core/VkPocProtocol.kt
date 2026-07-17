package bypass.whitelist.vkpoc.core

/**
 * Strict codec for the temporary Creator-compatible WLB-POC/1 wire format.
 *
 * This codec intentionally accepts printable ASCII only. A valid message has
 * exactly four fields separated by exactly three U+0020 space characters.
 */
object VkPocProtocol {
    const val VERSION = "WLB-POC/1"
    const val MAX_MESSAGE_LENGTH = 256
    const val MIN_REQUEST_ID_LENGTH = 16
    const val MAX_REQUEST_ID_LENGTH = 64
    const val MIN_NONCE_LENGTH = 16
    const val MAX_NONCE_LENGTH = 128

    data class Correlation(
        val requestId: String,
        val nonce: String,
    )

    fun formatPing(correlation: Correlation): String = format("PING", correlation)

    fun formatPong(correlation: Correlation): String = format("PONG", correlation)

    fun parsePing(value: String?): Correlation? = parse(value, "PING")

    fun parsePong(value: String?): Correlation? = parse(value, "PONG")

    fun isExactPong(value: String?, expected: Correlation): Boolean =
        parsePong(value) == expected

    fun isValidCorrelation(correlation: Correlation): Boolean =
        isBase64Url(
            correlation.requestId,
            MIN_REQUEST_ID_LENGTH,
            MAX_REQUEST_ID_LENGTH,
        ) &&
            isBase64Url(
                correlation.nonce,
                MIN_NONCE_LENGTH,
                MAX_NONCE_LENGTH,
            )

    private fun format(command: String, correlation: Correlation): String {
        require(isValidCorrelation(correlation)) { "Invalid WLB-POC/1 correlation fields" }
        val value = "$VERSION $command ${correlation.requestId} ${correlation.nonce}"
        check(value.length <= MAX_MESSAGE_LENGTH) { "WLB-POC/1 message exceeds its limit" }
        return value
    }

    private fun parse(value: String?, expectedCommand: String): Correlation? {
        if (value.isNullOrEmpty() || value.length > MAX_MESSAGE_LENGTH) return null
        if (value.any { it.code !in PRINTABLE_ASCII_RANGE }) return null
        if (value.count { it == ASCII_SPACE } != FIELD_SEPARATOR_COUNT) return null

        val prefix = "$VERSION $expectedCommand "
        if (!value.startsWith(prefix)) return null

        val correlationSeparator = value.indexOf(ASCII_SPACE, prefix.length)
        if (correlationSeparator < 0) return null

        val correlation = Correlation(
            requestId = value.substring(prefix.length, correlationSeparator),
            nonce = value.substring(correlationSeparator + 1),
        )
        return correlation.takeIf(::isValidCorrelation)
    }

    private fun isBase64Url(value: String, minimum: Int, maximum: Int): Boolean =
        value.length in minimum..maximum && value.all(::isBase64UrlCharacter)

    private fun isBase64UrlCharacter(character: Char): Boolean =
        character in 'A'..'Z' ||
            character in 'a'..'z' ||
            character in '0'..'9' ||
            character == '_' ||
            character == '-'

    private val PRINTABLE_ASCII_RANGE = 0x20..0x7e
    private const val ASCII_SPACE = ' '
    private const val FIELD_SEPARATOR_COUNT = 3
}
