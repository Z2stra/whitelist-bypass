package bypass.whitelist.vkpoc

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class VkPocSigningWrapperStaticTest {
    @Test
    fun `bootstrap wrapper requires the operator approved certificate fingerprint`() {
        val wrapper = repoFile("tools/invoke-poc-signing-smoke.ps1").readText()

        assertTrue(wrapper.contains("[string]\$ExpectedCertificateSha256"))
        assertTrue(wrapper.contains("ExpectedCertificateSha256 is required with -InitializeSigningIdentity"))
        assertTrue(wrapper.contains("\$ObservedCertificateSha256 -ne \$ExpectedCertificateSha256"))
        assertTrue(wrapper.contains("does not match ExpectedCertificateSha256"))
    }

    @Test
    fun `public identity is derived from accepted APK manifests`() {
        val wrapper = repoFile("tools/invoke-poc-signing-smoke.ps1").readText()

        assertTrue(wrapper.contains("\$ManifestApplicationId -ne \$ExpectedApplicationId"))
        assertTrue(wrapper.contains("\$AcceptedApplicationId = Assert-AcceptedProvenance"))
        assertTrue(wrapper.contains("applicationId = \$AcceptedApplicationId"))
    }

    private fun repoFile(path: String): File = File(repositoryRoot(), path).also {
        require(it.isFile) { "Missing repository fixture: $path" }
    }

    private fun repositoryRoot(): File {
        val userDirectory = requireNotNull(System.getProperty("user.dir")) {
            "Missing user.dir system property"
        }
        return generateSequence(File(userDirectory).canonicalFile) { it.parentFile }
            .firstOrNull { File(it, "android-app/app").isDirectory && File(it, "PRODUCT.md").isFile }
            ?: error("Could not locate repository root")
    }
}
