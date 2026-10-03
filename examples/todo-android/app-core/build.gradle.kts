plugins {
    kotlin("jvm")
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":kizunasync"))
    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit5:1.9.24")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    testImplementation("org.json:json:20240303")
    testRuntimeOnly("org.junit.jupiter:junit-jupiter-engine:5.10.2")
}

tasks.test {
    useJUnitPlatform()
    val monorepoRoot = file("../../..")
    workingDir = if (File(monorepoRoot, "Cargo.toml").isFile) monorepoRoot else projectDir
    val cargoDebug = File(workingDir, "target/debug")
    if (cargoDebug.isDirectory) {
        systemProperty("jna.library.path", cargoDebug.absolutePath)
        environment("DYLD_LIBRARY_PATH", cargoDebug.absolutePath)
        environment("LD_LIBRARY_PATH", cargoDebug.absolutePath)
    }
}
