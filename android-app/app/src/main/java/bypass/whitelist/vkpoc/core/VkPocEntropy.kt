package bypass.whitelist.vkpoc.core

import java.security.SecureRandom

/** Supplies fresh correlation values and a positive VK messages.send random_id. */
interface VkPocEntropy {
    fun newCorrelation(): VkPocProtocol.Correlation

    fun newPositiveRandomId(): Int
}

/**
 * Cryptographic, URL-safe entropy source. The 64-character alphabet permits an
 * unbiased mapping from the low six bits of every SecureRandom byte.
 */
class SecureVkPocEntropy(
    private val secureRandom: SecureRandom = SecureRandom(),
    private val requestIdLength: Int = DEFAULT_REQUEST_ID_LENGTH,
    private val nonceLength: Int = DEFAULT_NONCE_LENGTH,
) : VkPocEntropy {
    init {
        require(requestIdLength in VkPocProtocol.MIN_REQUEST_ID_LENGTH..VkPocProtocol.MAX_REQUEST_ID_LENGTH)
        require(nonceLength in VkPocProtocol.MIN_NONCE_LENGTH..VkPocProtocol.MAX_NONCE_LENGTH)
    }

    @Synchronized
    override fun newCorrelation(): VkPocProtocol.Correlation =
        VkPocProtocol.Correlation(
            requestId = newUrlSafeValue(requestIdLength),
            nonce = newUrlSafeValue(nonceLength),
        )

    @Synchronized
    override fun newPositiveRandomId(): Int = secureRandom.nextInt(Int.MAX_VALUE) + 1

    private fun newUrlSafeValue(length: Int): String {
        val randomBytes = ByteArray(length)
        secureRandom.nextBytes(randomBytes)
        return buildString(length) {
            randomBytes.forEach { byte ->
                append(URL_SAFE_ALPHABET[byte.toInt() and ALPHABET_MASK])
            }
        }
    }

    companion object {
        const val DEFAULT_REQUEST_ID_LENGTH = 24
        const val DEFAULT_NONCE_LENGTH = 32

        private const val URL_SAFE_ALPHABET =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
        private const val ALPHABET_MASK = 0x3f
    }
}
