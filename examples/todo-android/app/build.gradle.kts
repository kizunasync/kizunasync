plugins {
    id("com.android.application")
    kotlin("android")
}

fun resolveKizunaSyncVersion(): String {
    (findProperty("kizunasyncVersion") as String?)?.let { return it }
    val cargoToml = rootProject.file("../../Cargo.toml")
    if (cargoToml.isFile) {
        val afterHeader = cargoToml.readText().substringAfter("[workspace.package]", "")
        Regex("""version\s*=\s*"([^"]+)"""").find(afterHeader)?.let { return it.groupValues[1] }
    }
    throw GradleException("Unable to resolve the kizunasync version from Cargo.toml")
}

android {
    namespace = "com.kizunasync.todo"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.kizunasync.todo"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = resolveKizunaSyncVersion()
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
    sourceSets {
        getByName("main") {
            kotlin.srcDir("../app-core/src/main/kotlin")
        }
    }
}

dependencies {
    implementation(project(":kizunasync-android"))
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.ui:ui:1.7.6")
    implementation("androidx.compose.material3:material3:1.3.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.json:json:20240303")
}
