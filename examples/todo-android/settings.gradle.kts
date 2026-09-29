pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        kotlin("jvm") version "1.9.24"
        kotlin("android") version "1.9.24"
        id("com.android.application") version "8.6.1"
        id("com.android.library") version "8.6.1"
        // :kizunasync-android applies it; the version has to be declared where the build starts.
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

rootProject.name = "todo-android"
include(":app-core")
include(":kizunasync")
project(":kizunasync").projectDir = file("../../crates/kizunasync-ffi/bindings/kotlin")

val androidSdk =
    providers.environmentVariable("ANDROID_HOME").orElse(
        providers.environmentVariable("ANDROID_SDK_ROOT"),
    )
if (androidSdk.isPresent) {
    include(":app")
    // :kizunasync-android declares api(project(":engine")), so the engine module keeps that exact path here.
    include(":engine")
    project(":engine").projectDir = file("../../crates/kizunasync-ffi/bindings/kotlin/engine")
    include(":kizunasync-android")
    project(":kizunasync-android").projectDir =
        file("../../crates/kizunasync-ffi/bindings/kotlin/android")
}
