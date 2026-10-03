import com.vanniktech.maven.publish.MavenPublishBaseExtension

plugins {
    kotlin("jvm")
    id("com.android.library") apply false
    kotlin("android") apply false
    id("com.vanniktech.maven.publish") apply false
}

// The Cargo workspace root is 4 levels up from crates/kizunasync-ffi/bindings/kotlin.
val workspaceCargoToml = file("../../../../Cargo.toml")

fun resolveKizunaSyncVersion(): String {
    (findProperty("kizunasyncVersion") as String?)?.let { return it }
    if (workspaceCargoToml.isFile) {
        val afterHeader = workspaceCargoToml.readText().substringAfter("[workspace.package]", "")
        Regex("""version\s*=\s*"([^"]+)"""").find(afterHeader)?.let { return it.groupValues[1] }
    }
    throw GradleException(
        "Unable to resolve the kizunasync version: pass -PkizunasyncVersion=<X.Y.Z> or ensure " +
            "${workspaceCargoToml.path} has a version under [workspace.package].",
    )
}

allprojects {
    group = "com.kizunasync"
    version = resolveKizunaSyncVersion()
}

subprojects {
    plugins.withId("com.vanniktech.maven.publish") {
        extensions.configure<MavenPublishBaseExtension> {
            publishToMavenCentral(automaticRelease = true)
            // Maven Central refuses unsigned artifacts and release-kotlin.yml supplies this key; without it publishToMavenLocal stays unsigned.
            if (providers.gradleProperty("signingInMemoryKey").isPresent) {
                signAllPublications()
            }
            pom {
                url.set("https://kizunasync.com")
                inceptionYear.set("2026")
                licenses {
                    license {
                        name.set("Apache-2.0")
                        url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                        distribution.set("repo")
                    }
                }
                developers {
                    developer {
                        id.set("kizunasync")
                        name.set("Kizuna Sync")
                        email.set("kizunasync@smartsquad.io")
                        url.set("https://github.com/kizunasync")
                    }
                }
                scm {
                    url.set("https://github.com/kizunasync/kizunasync")
                    connection.set("scm:git:git://github.com/kizunasync/kizunasync.git")
                    developerConnection.set("scm:git:ssh://git@github.com/kizunasync/kizunasync.git")
                }
            }
        }
    }
}

val generatedKt = file("Generated/uniffi/kizunasync_ffi/kizunasync_ffi.kt")
val hasGenerated = generatedKt.isFile

dependencies {
    implementation(kotlin("stdlib"))
    implementation("org.json:json:20240303")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
    if (hasGenerated) {
        // UniFFI Kotlin bindings load libkizunasync_ffi via JNA.
        implementation("net.java.dev.jna:jna:5.14.0")
    }
    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit5:1.9.24")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    testRuntimeOnly("org.junit.jupiter:junit-jupiter-engine:5.10.2")
}

kotlin {
    jvmToolchain(17)
    sourceSets {
        val main by getting {
            kotlin {
                srcDir("src/main/kotlin")
                if (hasGenerated) {
                    // package uniffi.kizunasync_ffi coexists with the com.kizunasync.kizunasync app client
                    srcDir("Generated")
                }
            }
        }
        val test by getting {
            kotlin.srcDir("src/test/kotlin")
            // The shared scenario runner is test-only, so the AAR ships the app client alone.
            kotlin.srcDir("src/testFixtures/kotlin")
            if (hasGenerated) {
                // Tests that import uniffi.kizunasync_ffi only compile once bindgen has run.
                kotlin.srcDir("src/testGenerated/kotlin")
            }
        }
    }
}

tasks.test {
    useJUnitPlatform()
    // Resolves the monorepo root so JNA can find the cargo-built dylib.
    val monorepoRoot = file("../../../..")
    workingDir = if (File(monorepoRoot, "Cargo.toml").isFile) monorepoRoot else projectDir
    // Optional: JNA finds cargo-built dylib when UniFFI path is exercised.
    val cargoDebug = File(workingDir, "target/debug")
    // Gradle fingerprints only what a task declares, so a cargo rebuild of the library JNA loads would otherwise leave the tests up to date.
    inputs.file(File(cargoDebug, System.mapLibraryName("kizunasync_ffi")))
        .withPropertyName("kizunasyncFfiLibrary")
        .withPathSensitivity(PathSensitivity.NONE)
        .optional()
    if (cargoDebug.isDirectory) {
        systemProperty("jna.library.path", cargoDebug.absolutePath)
        environment("DYLD_LIBRARY_PATH", cargoDebug.absolutePath)
        environment("LD_LIBRARY_PATH", cargoDebug.absolutePath)
    }
}

tasks.register("printLayout") {
    doLast {
        println("hasGenerated=$hasGenerated path=${generatedKt.path}")
        println("scenario support: src/testFixtures/kotlin/com/kizunasync/kizunasync/KizunaSyncScenarioSupport.kt")
        println("tests: ./gradlew test  (needs: cargo build -p kizunasync-ffi)")
    }
}
