// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "TodoIos",
  platforms: [.macOS(.v13), .iOS(.v16)],
  products: [
    .library(name: "TodoIosCore", targets: ["TodoIosCore"]),
  ],
  dependencies: [
    .package(name: "KizunaSync", path: "../../crates/kizunasync-ffi/bindings/swift"),
  ],
  targets: [
    .target(
      name: "TodoIosCore",
      dependencies: [.product(name: "KizunaSync", package: "KizunaSync")]
    ),
    .testTarget(
      name: "TodoIosCoreTests",
      dependencies: ["TodoIosCore", .product(name: "KizunaSync", package: "KizunaSync")]
    ),
  ]
)
