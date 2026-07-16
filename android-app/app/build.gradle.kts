import java.io.File
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

val versionMajor = 0
val versionMinor = 3
val versionPatch = 7
val baseApplicationId = "bypass.whitelist"
val baseVersionName = "$versionMajor.$versionMinor.$versionPatch"
val baseVersionCode =
    versionMajor * 100_000_000 +
        versionMinor * 1_000_000 +
        versionPatch * 1_000
val pocBuildNumberRaw = System.getenv("WLB_POC_BUILD_NUMBER")
val pocBuildNumber = pocBuildNumberRaw?.toIntOrNull()
val configuredPocBuildNumber = pocBuildNumber?.takeIf { it in 1..999 } ?: 0
val configuredPocVersionCode = baseVersionCode + configuredPocBuildNumber
val pocAabUnsupportedMessage =
    "POC AAB is not supported; build the signed POC APK with :app:assemblePoc"

val repositoryRoot = rootProject.projectDir.parentFile.canonicalFile
val windowsHost = System.getProperty("os.name").startsWith("Windows", ignoreCase = true)

fun pathIsInsideDirectory(candidate: File, directory: File): Boolean {
    val candidatePath = candidate.canonicalFile.path.trimEnd(File.separatorChar)
    val directoryPath = directory.canonicalFile.path.trimEnd(File.separatorChar)
    return candidatePath.equals(directoryPath, ignoreCase = windowsHost) ||
        candidatePath.startsWith(directoryPath + File.separator, ignoreCase = windowsHost)
}

val signingPropertiesFile = rootProject.file("keystore.properties")
val signingProperties = Properties().apply {
    if (signingPropertiesFile.isFile) {
        signingPropertiesFile.inputStream().use { load(it) }
    }
}

// VK ID credentials and the private test-community identity are local live-test
// configuration. They are never committed. Environment variables are selected
// as one indivisible source whenever any WLB_VK_* value is present; otherwise
// Gradle reads the ignored android-app/vk-poc.local.properties file.
val vkPocPropertiesFile = rootProject.file("vk-poc.local.properties")
val vkPocProperties = Properties().apply {
    if (vkPocPropertiesFile.isFile) {
        vkPocPropertiesFile.inputStream().use { load(it) }
    }
}

val rawEnvironmentVkPocValues = linkedMapOf(
    "clientId" to System.getenv("WLB_VK_ID_CLIENT_ID"),
    "clientSecret" to System.getenv("WLB_VK_ID_CLIENT_SECRET"),
    "groupId" to System.getenv("WLB_VK_POC_GROUP_ID"),
)
val anyEnvironmentVkPocValue = rawEnvironmentVkPocValues.values.any { it != null }
val environmentVkPocValues = rawEnvironmentVkPocValues.mapValues { (_, value) ->
    value?.takeIf { it.isNotBlank() }
}
val propertyVkPocValues = linkedMapOf(
    "clientId" to vkPocProperties.getProperty("wlb.vk.clientId")?.takeIf { it.isNotBlank() },
    "clientSecret" to vkPocProperties.getProperty("wlb.vk.clientSecret")?.takeIf { it.isNotBlank() },
    "groupId" to vkPocProperties.getProperty("wlb.vk.groupId")?.takeIf { it.isNotBlank() },
)
val selectedVkPocValues =
    if (anyEnvironmentVkPocValue) environmentVkPocValues else propertyVkPocValues
val vkPocClientId = selectedVkPocValues.getValue("clientId")?.toIntOrNull()?.takeIf { it > 0 }
val vkPocClientSecret = selectedVkPocValues.getValue("clientSecret")
val vkPocGroupId = selectedVkPocValues.getValue("groupId")?.toLongOrNull()?.takeIf { it > 0L }
val vkPocInputsComplete =
    vkPocClientId != null && !vkPocClientSecret.isNullOrBlank() && vkPocGroupId != null
val vkPocUsesPublicCiPlaceholder =
    vkPocClientId == 1 ||
        vkPocGroupId == 1L ||
        vkPocClientSecret == "public-ci-placeholder-not-a-live-secret"
val vkPocPublicPlaceholderAllowed =
    System.getenv("GITHUB_ACTIONS").equals("true", ignoreCase = true) &&
        System.getenv("WLB_VK_ALLOW_PUBLIC_CI_PLACEHOLDER").equals("true", ignoreCase = true)
val vkPocConfigured = vkPocInputsComplete && !vkPocUsesPublicCiPlaceholder
val vkPocRuntimeGroupId = vkPocGroupId?.takeIf { vkPocConfigured } ?: 0L
val vkPocManifestClientId = vkPocClientId ?: 0
val vkPocManifestClientSecret = vkPocClientSecret ?: "not-configured"

fun nonEmptyEnvironmentValue(name: String): String? =
    System.getenv(name)?.takeIf { it.isNotEmpty() }

fun nonEmptyPropertyValue(name: String): String? =
    signingProperties.getProperty(name)?.takeIf { it.isNotEmpty() }

val environmentSigningValues = linkedMapOf(
    "storeFile" to nonEmptyEnvironmentValue("WLB_POC_KEYSTORE_PATH"),
    "storePassword" to nonEmptyEnvironmentValue("WLB_POC_KEYSTORE_PASSWORD"),
    "keyAlias" to nonEmptyEnvironmentValue("WLB_POC_KEY_ALIAS"),
    "keyPassword" to nonEmptyEnvironmentValue("WLB_POC_KEY_PASSWORD"),
)
val anyEnvironmentSigningValue = environmentSigningValues.values.any { !it.isNullOrEmpty() }
val allEnvironmentSigningValues = environmentSigningValues.values.all { !it.isNullOrEmpty() }

val propertySigningValues = linkedMapOf(
    "storeFile" to nonEmptyPropertyValue("wlb.poc.storeFile"),
    "storePassword" to nonEmptyPropertyValue("wlb.poc.storePassword"),
    "keyAlias" to nonEmptyPropertyValue("wlb.poc.keyAlias"),
    "keyPassword" to nonEmptyPropertyValue("wlb.poc.keyPassword"),
)

// Environment configuration is selected as one indivisible source whenever any
// WLB_POC_* signing value is present. Missing environment values are never filled
// from keystore.properties; the POC artifact gate reports the partial source.
val selectedSigningValues =
    if (anyEnvironmentSigningValue) environmentSigningValues else propertySigningValues

val pocStorePath = selectedSigningValues.getValue("storeFile")
val pocStorePassword = selectedSigningValues.getValue("storePassword")
val pocKeyAlias = selectedSigningValues.getValue("keyAlias")
val pocKeyPassword = selectedSigningValues.getValue("keyPassword")
val pocStoreFile = pocStorePath?.let(rootProject::file)
val missingPocStoreFile = layout.buildDirectory.file("missing-poc-signing-key.p12").get().asFile

fun requirePocBuildNumber(): Int {
    val value = pocBuildNumber
    if (value == null || value !in 1..999) {
        throw GradleException(
            "Signed POC packaging requires WLB_POC_BUILD_NUMBER from 1 to 999; " +
                "never reuse or decrease an accepted live build number",
        )
    }
    return value
}

fun validatePocPackagingInputs() {
    requirePocBuildNumber()

    if (!vkPocInputsComplete) {
        throw GradleException(
            "Signed POC packaging requires complete local WLB_VK_* or " +
                "vk-poc.local.properties configuration",
        )
    }
    if (vkPocUsesPublicCiPlaceholder && !vkPocPublicPlaceholderAllowed) {
        throw GradleException(
            "Signed POC packaging rejects public CI VK placeholders outside the explicit GitHub Actions smoke gate",
        )
    }

    if (anyEnvironmentSigningValue && !allEnvironmentSigningValues) {
        throw GradleException(
            "POC signing environment must provide all four WLB_POC_* signing values; " +
                "partial environment configuration cannot be mixed with keystore.properties",
        )
    }

    val missing = linkedMapOf(
        "WLB_POC_KEYSTORE_PATH / wlb.poc.storeFile" to pocStorePath,
        "WLB_POC_KEYSTORE_PASSWORD / wlb.poc.storePassword" to pocStorePassword,
        "WLB_POC_KEY_ALIAS / wlb.poc.keyAlias" to pocKeyAlias,
        "WLB_POC_KEY_PASSWORD / wlb.poc.keyPassword" to pocKeyPassword,
    ).filterValues { it.isNullOrEmpty() }.keys

    if (missing.isNotEmpty()) {
        throw GradleException(
            "POC signing is not configured. Missing: ${missing.joinToString()}",
        )
    }
    if (pocStoreFile?.isFile != true) {
        throw GradleException("POC signing keystore file does not exist")
    }
    if (pathIsInsideDirectory(pocStoreFile, repositoryRoot)) {
        throw GradleException(
            "POC signing keystore must be outside the repository, including ignored directories",
        )
    }
}

val verifyPocSigningInputs = tasks.register("verifyPocSigningInputs") {
    group = "verification"
    description = "Validates the external signing identity required for live POC APKs."
    doLast {
        validatePocPackagingInputs()
    }
}

val rejectPocBundle = tasks.register("rejectPocBundle") {
    group = "verification"
    description = "Rejects unsupported POC Android App Bundle production."
    doLast {
        throw GradleException(pocAabUnsupportedMessage)
    }
}

android {
    namespace = "bypass.whitelist"
    compileSdk {
        version = release(36)
    }

    defaultConfig {
        applicationId = baseApplicationId
        minSdk = 23
        targetSdk = 36
        versionCode = baseVersionCode
        versionName = baseVersionName

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Manual placeholders are an officially supported VK ID SDK setup path.
        // Safe sentinels keep ordinary public builds reproducible without live
        // credentials; the isolated screen fails closed until all local values exist.
        manifestPlaceholders["VKIDClientID"] = vkPocManifestClientId.toString()
        manifestPlaceholders["VKIDClientSecret"] = vkPocManifestClientSecret
        manifestPlaceholders["VKIDRedirectHost"] = "vk.ru"
        manifestPlaceholders["VKIDRedirectScheme"] = "vk$vkPocManifestClientId"
        buildConfigField("boolean", "VK_POC_CONFIGURED", vkPocConfigured.toString())
        buildConfigField("long", "VK_POC_GROUP_ID", "${vkPocRuntimeGroupId}L")
    }

    signingConfigs {
        create("poc") {
            storeType = "PKCS12"
            storeFile = pocStoreFile ?: missingPocStoreFile
            storePassword = pocStorePassword ?: "missing-poc-store-password"
            keyAlias = pocKeyAlias ?: "missing-poc-key-alias"
            keyPassword = pocKeyPassword ?: "missing-poc-key-password"
        }
    }

    buildTypes {
        getByName("debug") {
            // Use the standard machine-local Android debug key. No signing key is stored in Git.
            buildConfigField("boolean", "VK_POC_UI_ENABLED", "true")
        }
        getByName("release") {
            isMinifyEnabled = false
            // Production signing is intentionally not configured in this project yet.
            signingConfig = null
            // Ordinary release artifacts never inherit machine-local POC identity.
            manifestPlaceholders["VKIDClientID"] = "0"
            manifestPlaceholders["VKIDClientSecret"] = "not-configured"
            manifestPlaceholders["VKIDRedirectHost"] = "vk.ru"
            manifestPlaceholders["VKIDRedirectScheme"] = "vk0"
            buildConfigField("boolean", "VK_POC_CONFIGURED", "false")
            buildConfigField("long", "VK_POC_GROUP_ID", "0L")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            buildConfigField("boolean", "VK_POC_UI_ENABLED", "false")
        }
        create("poc") {
            initWith(getByName("release"))
            isDebuggable = false
            versionNameSuffix =
                "-poc.${if (configuredPocBuildNumber > 0) configuredPocBuildNumber else "local"}"
            matchingFallbacks += listOf("release")
            signingConfig = signingConfigs.getByName("poc")
            manifestPlaceholders["VKIDClientID"] = vkPocManifestClientId.toString()
            manifestPlaceholders["VKIDClientSecret"] = vkPocManifestClientSecret
            manifestPlaceholders["VKIDRedirectHost"] = "vk.ru"
            manifestPlaceholders["VKIDRedirectScheme"] = "vk$vkPocManifestClientId"
            buildConfigField("boolean", "VK_POC_CONFIGURED", vkPocConfigured.toString())
            buildConfigField("long", "VK_POC_GROUP_ID", "${vkPocRuntimeGroupId}L")
            buildConfigField("boolean", "VK_POC_UI_ENABLED", "true")
        }
    }
    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
}

// Only the POC APK receives the per-build live identity. Normal debug and
// release outputs retain the stable base versionCode regardless of the POC env.
androidComponents {
    onVariants(selector().withBuildType("poc")) { variant ->
        variant.outputs.forEach { output ->
            output.versionCode.set(configuredPocVersionCode)
        }
    }
}

// Supported APK-producing entry points and the AGP signing boundary must validate
// the external POC identity before the sentinel signing configuration is read.
tasks.matching {
    it.name in setOf(
        "validateSigningPoc",
        "assemblePoc",
        "installPoc",
        "packagePoc",
        "assemble",
        "build",
    )
}.configureEach {
    dependsOn(verifyPocSigningInputs)
}

// POC delivery is APK-only. Replace the public bundle lifecycle dependency graph
// and guard known AGP bundle-producing internals so no POC AAB can be emitted.
tasks.matching { it.name == "bundlePoc" }.configureEach {
    setDependsOn(listOf(rejectPocBundle))
}

tasks.matching {
    it.name in setOf(
        "buildPocPreBundle",
        "packagePocBundle",
        "signPocBundle",
    )
}.configureEach {
    dependsOn(rejectPocBundle)
}

tasks.register("printBaseIdentity") {
    group = "help"
    description = "Prints the package and version identity shared by normal non-POC variants."
    doLast {
        println("WLB_BASE_APPLICATION_ID=$baseApplicationId")
        println("WLB_BASE_VERSION_CODE=$baseVersionCode")
        println("WLB_BASE_VERSION_NAME=$baseVersionName")
    }
}

tasks.register("printPocIdentity") {
    group = "help"
    description = "Prints the expected package and version identity for a numbered POC APK."
    doLast {
        val buildNumber = requirePocBuildNumber()
        println("WLB_POC_APPLICATION_ID=$baseApplicationId")
        println("WLB_POC_VERSION_CODE=${baseVersionCode + buildNumber}")
        println("WLB_POC_VERSION_NAME=$baseVersionName-poc.$buildNumber")
    }
}

dependencies {
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar"))))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.viewpager2)
    implementation(libs.androidx.recyclerview)
    implementation(libs.vkid)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.gson)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
