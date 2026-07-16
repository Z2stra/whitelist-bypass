package bypass.whitelist.vkpoc

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class VkPocSecurityStaticTest {
    @Test
    fun `both Android backup formats exclude all VK ID session preferences`() {
        val legacyRules = repoFile("android-app/app/src/main/res/xml/backup_rules.xml").readText()
        val extractionRules =
            repoFile("android-app/app/src/main/res/xml/data_extraction_rules.xml").readText()

        SESSION_PREFERENCE_FILES.forEach { preferenceFile ->
            assertTrue(legacyRules.contains("path=\"$preferenceFile\""))
            assertTrue(extractionRules.contains("path=\"$preferenceFile\""))
        }
        assertTrue(extractionRules.contains("<cloud-backup>"))
        assertTrue(extractionRules.contains("<device-transfer>"))
    }

    @Test
    fun `POC artifact disables backup and cleartext and removes legacy components`() {
        val manifest = repoFile("android-app/app/src/poc/AndroidManifest.xml").readText()

        assertTrue(manifest.contains("android:name=\".vkpoc.VkPocApplication\""))
        assertTrue(manifest.contains("android:allowBackup=\"false\""))
        assertTrue(manifest.contains("android:dataExtractionRules=\"@xml/data_extraction_rules\""))
        assertTrue(manifest.contains("android:fullBackupContent=\"@xml/backup_rules\""))
        assertTrue(manifest.contains("android:usesCleartextTraffic=\"false\""))
        assertFalse(manifest.contains("tools:remove=\"android:dataExtractionRules"))
        assertTrue(manifest.contains("android:name=\".vkpoc.VkPocActivity\""))
        assertTrue(manifest.contains("android.intent.category.LAUNCHER"))
        listOf(
            ".MainActivity",
            ".tunnel.TunnelVpnService",
            ".tunnel.ProxyService",
            ".tunnel.HeadlessSessionService",
            ".tunnel.VpnTileService",
            "androidx.core.content.FileProvider",
        ).forEach { component ->
            assertTrue(manifest.contains("android:name=\"$component\""))
            assertTrue(
                manifest.substringAfter("android:name=\"$component\"")
                    .substringBefore("/>")
                    .contains("tools:node=\"remove\""),
            )
        }
    }

    @Test
    fun `POC implementation has no app logger preferences or token output path`() {
        val sourceDirectory = repoFile("android-app/app/src/main/java/bypass/whitelist/vkpoc")
        val sources = sourceDirectory.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .joinToString("\n") { it.readText() }

        listOf(
            "android.util.Log",
            "LogWriter",
            "Prefs.",
            "println(",
            "printStackTrace(",
            "ClipboardManager",
            "FileProvider",
        ).forEach { forbidden -> assertFalse(forbidden, sources.contains(forbidden)) }
        assertFalse(sources.contains("accessToken.token}"))
        assertFalse(sources.contains("fail.description"))
        assertFalse(sources.contains("error_msg"))
    }

    @Test
    fun `live VK configuration file is ignored and example contains no usable values`() {
        val rootIgnore = repoFile(".gitignore").readText()
        val androidIgnore = repoFile("android-app/.gitignore").readText()
        val example = repoFile("android-app/vk-poc.local.properties.example").readText()

        assertTrue(rootIgnore.contains("vk-poc.local.properties"))
        assertTrue(androidIgnore.contains("vk-poc.local.properties"))
        assertTrue(example.contains("wlb.vk.clientId="))
        assertTrue(example.contains("wlb.vk.clientSecret="))
        assertTrue(example.contains("wlb.vk.groupId="))
        assertFalse(Regex("wlb\\.vk\\.clientId=\\d+").containsMatchIn(example))
        assertFalse(Regex("wlb\\.vk\\.groupId=\\d+").containsMatchIn(example))
    }

    @Test
    fun `release identity is sentinel-only and POC packaging rejects incomplete config`() {
        val buildScript = repoFile("android-app/app/build.gradle.kts").readText()

        assertTrue(buildScript.contains("if (anyEnvironmentVkPocValue) environmentVkPocValues"))
        assertTrue(buildScript.contains("Signed POC packaging requires complete local WLB_VK_*"))
        assertTrue(buildScript.contains("Signed POC packaging rejects public CI VK placeholders"))
        val releaseBlock = buildScript.substringAfter("getByName(\"release\")")
            .substringBefore("create(\"poc\")")
        assertTrue(releaseBlock.contains("manifestPlaceholders[\"VKIDClientID\"] = \"0\""))
        assertTrue(releaseBlock.contains("buildConfigField(\"boolean\", \"VK_POC_CONFIGURED\", \"false\")"))
        assertTrue(releaseBlock.contains("buildConfigField(\"long\", \"VK_POC_GROUP_ID\", \"0L\")"))
    }

    @Test
    fun `normal release removes all official VK ID auth activities`() {
        val manifest = repoFile("android-app/app/src/release/AndroidManifest.xml").readText()

        listOf(
            "com.vk.id.internal.auth.AuthActivity",
            "com.vk.id.internal.auth.RedirectUriReceiverActivity",
        ).forEach { activity ->
            val declaration = manifest.substringAfter("android:name=\"$activity\"")
                .substringBefore("/>")
            assertTrue(declaration.contains("tools:node=\"remove\""))
        }
    }

    private fun repoFile(path: String): File = File(repositoryRoot(), path).also {
        require(it.exists()) { "Missing repository fixture: $path" }
    }

    private fun repositoryRoot(): File =
        generateSequence(File(System.getProperty("user.dir")).canonicalFile) { it.parentFile }
            .firstOrNull { File(it, "android-app/app").isDirectory && File(it, "PRODUCT.md").isFile }
            ?: error("Could not locate repository root")

    companion object {
        val SESSION_PREFERENCE_FILES = listOf(
            "vkid_encrypted_shared_prefs.xml",
            "bypass.whitelist_preferences.xml",
        )
    }
}
