// swift-tools-version:5.9
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
import PackageDescription

let package = Package(
    name: "tauri-plugin-pages",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-pages", type: .static, targets: ["tauri-plugin-pages"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [
        .target(name: "tauri-plugin-pages", dependencies: [.byName(name: "Tauri")], path: "Sources"),
        .testTarget(name: "PagesTests", dependencies: ["tauri-plugin-pages", .byName(name: "Tauri")], path: "Tests")
    ]
)
