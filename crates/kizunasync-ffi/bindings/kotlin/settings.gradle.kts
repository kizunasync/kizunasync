pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        id("com.android.library") version "8.6.1"
        kotlin("android") version "1.9.24"
        kotlin("jvm") version "1.9.24"
        id("com.vanniktech.maven.publish") version "0.34.0"
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "kizunasync-kotlin"

// The Android library needs an SDK. Host `gradle test` (bindings-kotlin CI) stays
// JVM-only when ANDROID_HOME / ANDROID_SDK_ROOT are unset.
val androidSdk =
    providers.environmentVariable("ANDROID_HOME").orElse(
        providers.environmentVariable("ANDROID_SDK_ROOT"),
    )
if (androidSdk.isPresent) {
    include(":engine")
    include(":android")
}
