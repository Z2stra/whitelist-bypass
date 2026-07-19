package bypass.whitelist.vkpoc

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class VkPocSigningHelperStaticTest {
    @Test
    fun `signing helper verifies complete isolation from the built manifest tree`() {
        val helper = repoFile("tools/preserve-poc-signing-smoke.ps1").readText()

        assertTrue(helper.contains("@('dump', 'xmltree', \$ApkPath, 'AndroidManifest.xml')"))
        assertTrue(helper.contains("\$ExpectedPocLauncher = 'app.northbridge.mobile.EntryActivity'"))
        assertTrue(helper.contains("application|activity|activity-alias|service|provider"))
        assertTrue(helper.contains("android:allowBackup"))
        assertTrue(helper.contains("android:usesCleartextTraffic"))
        assertTrue(helper.contains("\$LauncherBlocks.Count -ne 1"))
        assertTrue(helper.contains("bypass.whitelist.MainActivity"))
        assertTrue(helper.contains("bypass.whitelist.tunnel.TunnelVpnService"))
        assertTrue(helper.contains("androidx.core.content.FileProvider"))
        assertTrue(helper.contains("android:targetActivity"))
        assertTrue(helper.contains("android\\.intent\\.action\\.MAIN"))
        assertTrue(helper.contains("android\\.intent\\.category\\.LAUNCHER"))
        assertTrue(helper.contains("POC APK target activity must remain unexported"))
        assertFalse(helper.contains("launchable-activity:"))
    }

    @Test
    fun `signing helper pins Gradle application identity before packaging`() {
        val helper = repoFile("tools/preserve-poc-signing-smoke.ps1").readText()

        assertTrue(helper.contains("\$PocApplicationIds.Count -ne 1"))
        assertTrue(helper.contains("\$PocApplicationIds[0] -ne \$ExpectedApplicationId"))
        assertTrue(helper.contains("Gradle POC applicationId does not match the pinned external identity"))
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
