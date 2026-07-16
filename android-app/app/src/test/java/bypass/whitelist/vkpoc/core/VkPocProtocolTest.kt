package bypass.whitelist.vkpoc.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class VkPocProtocolTest {
    @Test
    fun `format and parse match Creator grammar exactly`() {
        val correlation = VkPocProtocol.Correlation(REQUEST_ID, NONCE)

        val ping = VkPocProtocol.formatPing(correlation)
        val pong = VkPocProtocol.formatPong(correlation)

        assertEquals("WLB-POC/1 PING $REQUEST_ID $NONCE", ping)
        assertEquals("WLB-POC/1 PONG $REQUEST_ID $NONCE", pong)
        assertEquals(correlation, VkPocProtocol.parsePing(ping))
        assertEquals(correlation, VkPocProtocol.parsePong(pong))
        assertTrue(VkPocProtocol.isExactPong(pong, correlation))
    }

    @Test
    fun `minimum and maximum bounded fields are accepted`() {
        val minimum = VkPocProtocol.Correlation("a".repeat(16), "B".repeat(16))
        val maximum = VkPocProtocol.Correlation("_".repeat(64), "-".repeat(128))

        assertEquals(minimum, VkPocProtocol.parsePing(VkPocProtocol.formatPing(minimum)))
        assertEquals(maximum, VkPocProtocol.parsePong(VkPocProtocol.formatPong(maximum)))
        assertTrue(VkPocProtocol.formatPong(maximum).length <= VkPocProtocol.MAX_MESSAGE_LENGTH)
    }

    @Test
    fun `parser rejects non-exact spacing commands case and ASCII`() {
        val invalid = listOf(
            " WLB-POC/1 PONG $REQUEST_ID $NONCE",
            "WLB-POC/1 PONG $REQUEST_ID $NONCE ",
            "WLB-POC/1  PONG $REQUEST_ID $NONCE",
            "WLB-POC/1 PONG  $REQUEST_ID $NONCE",
            "WLB-POC/1 PONG $REQUEST_ID  $NONCE",
            "WLB-POC/1\tPONG $REQUEST_ID $NONCE",
            "WLB-POC/1 PONG $REQUEST_ID\n$NONCE",
            "WLB-POC/1 PONG $REQUEST_ID ${NONCE.dropLast(1)}\u007f",
            "WLB-POC/1 PONG $REQUEST_ID ${NONCE.dropLast(1)}é",
            "wlb-poc/1 PONG $REQUEST_ID $NONCE",
            "WLB-POC/1 pong $REQUEST_ID $NONCE",
            "WLB-POC/2 PONG $REQUEST_ID $NONCE",
            "WLB-POC/1 PING $REQUEST_ID $NONCE",
            "WLB-POC/1 PONG $REQUEST_ID $NONCE extra",
        )

        invalid.forEach { value -> assertNull(value, VkPocProtocol.parsePong(value)) }
    }

    @Test
    fun `parser rejects malformed fields and oversized input`() {
        val invalid = listOf(
            "WLB-POC/1 PONG short $NONCE",
            "WLB-POC/1 PONG ${"r".repeat(65)} $NONCE",
            "WLB-POC/1 PONG $REQUEST_ID short",
            "WLB-POC/1 PONG $REQUEST_ID ${"n".repeat(129)}",
            "WLB-POC/1 PONG request+invalid123 $NONCE",
            "WLB-POC/1 PONG $REQUEST_ID nonce=invalid1234",
            "x".repeat(VkPocProtocol.MAX_MESSAGE_LENGTH + 1),
        )

        invalid.forEach { value -> assertNull(value, VkPocProtocol.parsePong(value)) }
        assertNull(VkPocProtocol.parsePong(null))
        assertNull(VkPocProtocol.parsePong(""))
    }

    @Test
    fun `PONG requires the exact request and nonce pair`() {
        val expected = VkPocProtocol.Correlation(REQUEST_ID, NONCE)
        val wrongRequest = VkPocProtocol.formatPong(
            expected.copy(requestId = OTHER_REQUEST_ID),
        )
        val wrongNonce = VkPocProtocol.formatPong(
            expected.copy(nonce = OTHER_NONCE),
        )

        assertFalse(VkPocProtocol.isExactPong(wrongRequest, expected))
        assertFalse(VkPocProtocol.isExactPong(wrongNonce, expected))
        assertFalse(VkPocProtocol.isExactPong("not a protocol message", expected))
    }

    @Test
    fun `formatter rejects invalid caller supplied correlation`() {
        assertThrows(IllegalArgumentException::class.java) {
            VkPocProtocol.formatPing(VkPocProtocol.Correlation("short", NONCE))
        }
        assertThrows(IllegalArgumentException::class.java) {
            VkPocProtocol.formatPong(VkPocProtocol.Correlation(REQUEST_ID, "bad+nonce_value"))
        }
    }

    @Test
    fun `secure generator creates bounded URL-safe values and positive random ids`() {
        val entropy = SecureVkPocEntropy()
        repeat(64) {
            val correlation = entropy.newCorrelation()
            assertNotNull(VkPocProtocol.parsePing(VkPocProtocol.formatPing(correlation)))
            assertEquals(SecureVkPocEntropy.DEFAULT_REQUEST_ID_LENGTH, correlation.requestId.length)
            assertEquals(SecureVkPocEntropy.DEFAULT_NONCE_LENGTH, correlation.nonce.length)
            assertTrue(correlation.requestId.all(::isUrlSafe))
            assertTrue(correlation.nonce.all(::isUrlSafe))
            assertTrue(entropy.newPositiveRandomId() > 0)
        }
    }

    private fun isUrlSafe(character: Char): Boolean =
        character.isLetterOrDigit() || character == '_' || character == '-'

    companion object {
        const val REQUEST_ID = "req_1234567890abcd"
        const val NONCE = "nonce_1234567890abcdef"
        const val OTHER_REQUEST_ID = "req_abcdefghij9876"
        const val OTHER_NONCE = "nonce_abcdefghijklmnop"
    }
}
