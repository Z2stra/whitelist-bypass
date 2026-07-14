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
val pocBuildNumberRaw = System.getenv("WLB_POC_BUILD_NUMBER")
val pocBuildNumber = pocBuildNumberRaw?.toIntOrNull()
val configuredPocBuildNumber = pocBuildNumber?.takeIf { it in 1..999 } ?: 0
val configuredVersionCode =
    versionMajor * 100_000_000 +
        versionMinor * 1_000_000 +
        versionPatch * 1_000 +
        configuredPocBuildNumber

val signingPropertiesFile = rootProject.file("keystore.properties")
val signingProperties = Properties().apply {
    if (signingPropertiesFile.isFile) {
        signingPropertiesFile.inputStream().use { load(it) }
    }
}

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

if (anyEnvironmentSigningValue && !allEnvironmentSigningValues) {
    throw GradleException(
        "POC signing environment must provide all four WLB_POC_* signing values; " +
            "partial environment configuration cannot be mixed with keystore.properties",
    )
}

val propertySigningValues = linkedMapOf(
    "storeFile" to nonEmptyPropertyValue("wlb.poc.storeFile"),
    "storePassword" to nonEmptyPropertyValue("wlb.poc.storePassword"),
    "keyAlias" to nonEmptyPropertyValue("wlb.poc.keyAlias"),
    "keyPassword" to nonEmptyPropertyValue("wlb.poc.keyPassword"),
)
val selectedSigningValues =
    if (allEnvironmentSigningValues) environmentSigningValues else propertySigningValues

val pocStorePath = selectedSigningValues.getValue("storeFile")
val pocStorePassword = selectedSigningValues.getValue("storePassword")
val pocKeyAlias = selectedSigningValues.getValue("keyAlias")
val pocKeyPassword = selectedSigningValues.getValue("keyPassword")
val pocSigningValuesPresent = selectedSigningValues.values.all { !it.isNullOrEmpty() }
val pocStoreFile = pocStorePath?.let(rootProject::file)
val missingPocStoreFile = layout.buildDirectory.file("missing-poc-signing-key.p12").get().asFile

fun requirePocBuildNumber(): Int {
    val value = pocBuildNumber
    if (value == null || value !in 1..999) {
        throw GradleException(
            "Signed POC packaging requires WLB_POC_BUILD_NUMBER from 1 to 999; " +
                "use a strictly increasing value for every live APK",
        )
    }
    return value
}

fun validatePocPackagingInputs() {
    requirePocBuildNumber()

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
}

val verifyPocSigningInputs = tasks.register("verifyPocSigningInputs") {
    group = "verification"
    description = "Validates the external signing identity required for live POC artifacts."
    doLast {
        validatePocPackagingInputs()
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
        versionCode = configuredVersionCode
        versionName = baseVersionName

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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
        }
        getByName("release") {
            isMinifyEnabled = false
            // Production signing is intentionally not configured in this project yet.
            signingConfig = null
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        create("poc") {
            initWith(getByName("release"))
            isDebuggable = false
            versionNameSuffix =
                "-poc.${if (configuredPocBuildNumber > 0) configuredPocBuildNumber else "local"}"
            matchingFallbacks += listOf("release")
            signingConfig = signingConfigs.getByName("poc")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
}

// validateSigningPoc is the central AGP signing boundary used by APK/AAB packaging.
// Public lifecycle tasks are included as an explicit regression-safe fallback.
tasks.matching {
    it.name in setOf(
        "validateSigningPoc",
        "assemblePoc",
        "bundlePoc",
        "installPoc",
        "packagePoc",
    )
}.configureEach {
    dependsOn(verifyPocSigningInputs)
}

tasks.register("printPocIdentity") {
    group = "help"
    description = "Prints the expected package and version identity for a numbered POC build."
    doLast {
        val buildNumber = requirePocBuildNumber()
        val versionCode =
            versionMajor * 100_000_000 +
                versionMinor * 1_000_000 +
                versionPatch * 1_000 +
                buildNumber
        println("WLB_POC_APPLICATION_ID=$baseApplicationId")
        println("WLB_POC_VERSION_CODE=$versionCode")
        println("WLB_POC_VERSION_NAME=$baseVersionName-poc.$buildNumber")
    }
}

dependencies {
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar"))))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.viewpager2)
    implementation(libs.androidx.recyclerview)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
