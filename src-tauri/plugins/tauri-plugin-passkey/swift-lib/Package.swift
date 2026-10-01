// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PasskeyBridge",
    platforms: [
        .macOS("15.0")
    ],
    products: [
        .library(name: "PasskeyBridge", type: .static, targets: ["PasskeyBridge"])
    ],
    dependencies: [
        .package(url: "https://github.com/Brendonovich/swift-rs", from: "1.0.6")
    ],
    targets: [
        .target(
            name: "PasskeyBridge",
            dependencies: [
                .product(name: "SwiftRs", package: "swift-rs")
            ]
        )
    ]
)
