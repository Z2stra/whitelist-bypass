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
                "use a strictly increasing value for every live APK",
        )
    }
    return value
}

fun validatePocPackagingInputs() {
    requirePocBuildNumber()

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
        versionCode = baseVersionCode
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

// Only the POC variant receives the per-build live identity. Normal debug and
// release outputs retain the stable base versionCode regardless of the POC env.
androidComponents {
    onVariants(selector().withBuildType("poc")) { variant ->
        variant.outputs.forEach { output ->
            output.versionCode.set(configuredPocVersionCode)
        }
    }
}

// validateSigningPoc is the central AGP signing boundary used by APK/AAB packaging.
// Public variant and aggregate lifecycle tasks are included as regression-safe fallbacks.
tasks.matching {
    it.name in setOf(
        "validateSigningPoc",
        "assemblePoc",
        "bundlePoc",
        "installPoc",
        "packagePoc",
        "assemble",
        "bundle",
        "build",
    )
}.configureEach {
    dependsOn(verifyPocSigningInputs)
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
    description = "Prints the expected package and version identity for a numbered POC build."
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
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.viewpager2)
    implementation(libs.androidx.recyclerview)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
