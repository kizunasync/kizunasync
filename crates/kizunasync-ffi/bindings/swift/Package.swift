// swift-tools-version: 5.9
import Foundation
import PackageDescription

// `KizunaSync` is the app client and always builds. UniFFI `KizunaSyncFfi` is added only
// when Generated/kizunasync_ffi.swift exists (from `bun run cargo:bindgen`).
let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let generatedHeader = packageRoot.appendingPathComponent("Generated/kizunasync_ffiFFI.h")
let hasGenerated = FileManager.default.fileExists(
  atPath: packageRoot.appendingPathComponent("Generated/kizunasync_ffi.swift").path
)
let xcframeworkRoot = packageRoot.appendingPathComponent("KizunaSyncFfi.xcframework")
let hasXcframework = FileManager.default.fileExists(atPath: xcframeworkRoot.path)

/// Resolve monorepo `target/debug` that contains cargo-built `libkizunasync_ffi`.
func resolveCargoLibDir() -> String? {
  var dir = packageRoot
  for _ in 0..<12 {
    let debug = dir.appendingPathComponent("target/debug")
    let dylib = debug.appendingPathComponent("libkizunasync_ffi.dylib")
    let so = debug.appendingPathComponent("libkizunasync_ffi.so")
    if FileManager.default.fileExists(atPath: dylib.path)
      || FileManager.default.fileExists(atPath: so.path)
    {
      return debug.path
    }
    let parent = dir.deletingLastPathComponent()
    if parent.path == dir.path { break }
    dir = parent
  }
  return nil
}

/// A present framework wins over the cargo library for every lane, so one built
/// before the last bindgen would link a binary without the symbols the
/// generated Swift calls. Comparing the headers catches that before the linker
/// reports it as a missing symbol or a checksum mismatch at runtime.
func assertXcframeworkMatchesGeneratedHeader() {
  guard let expected = try? Data(contentsOf: generatedHeader) else {
    return
  }
  let slices = (try? FileManager.default.contentsOfDirectory(
    at: xcframeworkRoot,
    includingPropertiesForKeys: nil
  )) ?? []
  for slice in slices {
    let header = slice.appendingPathComponent("Headers/kizunasync_ffiFFI.h")
    guard let found = try? Data(contentsOf: header) else { continue }
    if found != expected {
      fatalError(
        """
        KizunaSyncFfi.xcframework is stale: \(slice.lastPathComponent)/Headers/kizunasync_ffiFFI.h \
        differs from Generated/kizunasync_ffiFFI.h. Rebuild it from the repository root \
        with `bun run cargo:xcframework`, or remove the directory to link the \
        cargo-built library instead.
        """
      )
    }
  }
}

if hasXcframework {
  assertXcframeworkMatchesGeneratedHeader()
}

var products: [Product] = [
  .library(name: "KizunaSync", targets: ["KizunaSync"]),
]

var targets: [Target] = [
  .target(
    name: "KizunaSync",
    dependencies: hasGenerated ? ["KizunaSyncFfi"] : [],
    path: "Sources/KizunaSync"
  ),
  .target(
    name: "KizunaSyncScenarioSupport",
    path: "Sources/KizunaSyncScenarioSupport"
  ),
  .testTarget(
    name: "KizunaSyncTests",
    dependencies: ["KizunaSync", "KizunaSyncScenarioSupport"],
    path: "Tests/KizunaSyncTests"
  ),
]

if hasGenerated {
  products.append(.library(name: "KizunaSyncFfi", targets: ["KizunaSyncFfi"]))

  /// `KizunaSyncFfi` depends on exactly one provider of the `kizunasync_ffiFFI` module.
  /// Xcode's build system aggregates every target's public module maps into
  /// one path and fails a scan that finds two providers of the same module
  /// name; plain SwiftPM tolerates it, which is why `swift test` stayed
  /// green while an app target built through Xcode did not.
  var kizunasyncFfiDependencies: [Target.Dependency] = []
  var linkerSettings: [LinkerSetting] = []

  if hasXcframework {
    // Device / simulator apps: Mozilla local-SPM shape.
    targets.append(
      .binaryTarget(
        name: "KizunaSyncFfiRust",
        path: "KizunaSyncFfi.xcframework"
      )
    )
    kizunasyncFfiDependencies.append("KizunaSyncFfiRust")
    // The engine binary alone, which @kizunasync/rn-uniffi links. Apps depend on KizunaSync.
    products.append(.library(name: "KizunaSyncEngine", targets: ["KizunaSyncFfiRust"]))
  } else {
    // Host `swift test`: the local C target is the module provider, linked
    // against the cargo debug dylib when one is found, no XCFramework required.
    kizunasyncFfiDependencies.append("kizunasync_ffiFFI")
    if let libDir = resolveCargoLibDir() {
      linkerSettings = [
        .unsafeFlags([
          "-L\(libDir)",
          "-lkizunasync_ffi",
          "-Xlinker", "-rpath",
          "-Xlinker", libDir,
        ]),
      ]
    }
  }

  targets.append(contentsOf: [
    .target(
      name: "kizunasync_ffiFFI",
      path: "Sources/kizunasync_ffiFFI",
      publicHeadersPath: "include"
    ),
    .target(
      name: "KizunaSyncFfi",
      dependencies: kizunasyncFfiDependencies,
      path: "Generated",
      exclude: [
        "README.md",
        "kizunasync_ffiFFI.h",
        "kizunasync_ffiFFI.modulemap",
      ],
      sources: ["kizunasync_ffi.swift"],
      linkerSettings: linkerSettings
    ),
    .testTarget(
      name: "KizunaSyncFfiTests",
      dependencies: ["KizunaSync", "KizunaSyncFfi", "KizunaSyncScenarioSupport"],
      path: "Tests/KizunaSyncFfiTests"
    ),
  ])
}

let package = Package(
  name: "KizunaSync",
  platforms: [.macOS(.v13), .iOS(.v16)],
  products: products,
  targets: targets
)
