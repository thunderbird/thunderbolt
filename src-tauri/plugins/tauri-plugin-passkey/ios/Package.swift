// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-passkey",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "tauri-plugin-passkey", type: .static, targets: ["tauri-plugin-passkey"])
    ],
    dependencies: [
        // Tauri injects its Swift API package here during `tauri ios` builds.
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-passkey",
            dependencies: [.byName(name: "Tauri")],
            path: "Sources"
        )
    ]
)
