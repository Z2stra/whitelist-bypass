import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

val versionMajor = 0
val versionMinor = 3
val versionPatch = 7
val versionBuildRaw = System.getenv("BUILD_NUMBER")
val versionBuild = versionBuildRaw?.toIntOrNull() ?: 0

if (versionBuildRaw != null && (versionBuildRaw.toIntOrNull() == null || versionBuild !in 0..999)) {
    throw GradleException("BUILD_NUMBER must be an integer from 0 to 999")
}

val signingPropertiesFile = rootProject.file("keystore.properties")
val signingProperties = Properties().apply {
    if (signingPropertiesFile.isFile) {
        signingPropertiesFile.inputStream().use { load(it) }
    }
}

fun signingValue(environmentName: String, propertyName: String): String? {
    return System.getenv(environmentName)?.takeIf { it.isNotEmpty() }
        ?: signingProperties.getProperty(propertyName)?.takeIf { it.isNotEmpty() }
}

val pocStorePath = signingValue("WLB_POC_KEYSTORE_PATH", "wlb.poc.storeFile")
val pocStorePassword = signingValue("WLB_POC_KEYSTORE_PASSWORD", "wlb.poc.storePassword")
val pocKeyAlias = signingValue("WLB_POC_KEY_ALIAS", "wlb.poc.keyAlias")
val pocKeyPassword = signingValue("WLB_POC_KEY_PASSWORD", "wlb.poc.keyPassword")
val pocSigningValuesPresent = listOf(
    pocStorePath,
    pocStorePassword,
    pocKeyAlias,
    pocKeyPassword,
).all { !it.isNullOrEmpty() }
val pocStoreFile = pocStorePath?.let(rootProject::file)

fun validatePocPackagingInputs() {
    if (versionBuildRaw == null || versionBuild !in 1..999) {
        throw GradleException(
            "Signed POC packaging requires BUILD_NUMBER from 1 to 999 so every live APK has a unique versionCode",
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

fun isPocPackagingTask(taskName: String): Boolean {
    return when (taskName.substringAfterLast(':').lowercase()) {
        "assemblepoc", "bundlepoc", "installpoc", "packagepoc" -> true
        else -> false
    }
}

if (gradle.startParameter.taskNames.any(::isPocPackagingTask)) {
    validatePocPackagingInputs()
}

gradle.taskGraph.whenReady {
    if (allTasks.any { isPocPackagingTask(it.path) }) {
        validatePocPackagingInputs()
    }
}

android {
    namespace = "bypass.whitelist"
    compileSdk {
        version = release(36)
    }

    defaultConfig {
        applicationId = "bypass.whitelist"
        minSdk = 23
        targetSdk = 36
        versionCode =
            versionMajor * 100_000_000 +
                versionMinor * 1_000_000 +
                versionPatch * 1_000 +
                versionBuild
        versionName = "$versionMajor.$versionMinor.$versionPatch"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (pocSigningValuesPresent) {
            create("poc") {
                storeFile = pocStoreFile
                storePassword = pocStorePassword
                keyAlias = pocKeyAlias
                keyPassword = pocKeyPassword
            }
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
            versionNameSuffix = "-poc.${if (versionBuild > 0) versionBuild else "local"}"
            matchingFallbacks += listOf("release")
            if (pocSigningValuesPresent) {
                signingConfig = signingConfigs.getByName("poc")
            }
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
