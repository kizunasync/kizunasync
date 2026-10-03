import com.vanniktech.maven.publish.AndroidSingleVariantLibrary

plugins {
    id("com.android.library")
    id("com.vanniktech.maven.publish")
}

android {
    namespace = "com.kizunasync.kizunasync.engine"
    compileSdk = 35
    defaultConfig {
        // The API level cargo-ndk links the library against; the manifest merge rejects a floor above the consumer's minSdk.
        minSdk = 21
    }
}

mavenPublishing {
    coordinates("com.kizunasync", "kizunasync-engine", project.version.toString())
    configure(
        AndroidSingleVariantLibrary(
            variant = "release",
            sourcesJar = true,
            publishJavadocJar = true,
        ),
    )
    pom {
        name.set("Kizuna Sync engine for Android")
        description.set("The Kizuna Sync Rust engine as libkizunasync_ffi.so for arm64-v8a, armeabi-v7a, and x86_64, shared by the Kotlin app client and the React Native module.")
    }
}
