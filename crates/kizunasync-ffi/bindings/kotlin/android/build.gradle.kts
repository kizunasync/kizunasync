import com.vanniktech.maven.publish.AndroidSingleVariantLibrary

plugins {
    id("com.android.library")
    kotlin("android")
    id("com.vanniktech.maven.publish")
}

android {
    namespace = "com.kizunasync.kizunasync"
    compileSdk = 35
    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    sourceSets {
        getByName("main") {
            kotlin.srcDir("../Generated")
            kotlin.srcDir("../src/main/kotlin")
            // Android-only host code: KizunaSyncConnectivityPathMonitor needs android.net.
            kotlin.srcDir("src/main/kotlin")
        }
    }
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }
}

dependencies {
    api(project(":engine"))
    implementation("net.java.dev.jna:jna:5.14.0@aar")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
    implementation("org.json:json:20240303")
    // KizunaSyncProcessForegroundSource observes the process lifecycle, which lives
    // in this artifact rather than in the runtime the platform ships.
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.lifecycle:lifecycle-runtime-testing:2.8.7")
}

mavenPublishing {
    coordinates("com.kizunasync", "kizunasync", project.version.toString())
    configure(
        AndroidSingleVariantLibrary(
            variant = "release",
            sourcesJar = true,
            publishJavadocJar = true,
        ),
    )
    pom {
        name.set("Kizuna Sync for Kotlin")
        description.set("Typed Kotlin app client over the Kizuna Sync Rust engine: offline reads and writes on local SQLite with sync through your Supabase project.")
    }
}
