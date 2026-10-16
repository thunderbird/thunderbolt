/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Commands exposed to the webview; must match the `#[tauri::command]`s in
// src/commands.rs and be listed in permissions/default.toml.
const COMMANDS: &[&str] = &["register", "authenticate"];

fn main() {
    // Compile + link the macOS-only Swift ceremony (swift-rs). iOS builds use the
    // separate `ios/` Tauri mobile plugin (compiled by Xcode), NOT this static lib.
    //
    // The outer cfg gates on the HOST (build scripts always run on the host, and
    // swift-rs is a macOS-host build-dependency). The inner check gates on the build
    // TARGET via CARGO_CFG_TARGET_OS — because `cfg!(target_os)` in a build script
    // reflects the host, not the target, so cross-compiling to iOS would otherwise
    // wrongly try to build the macOS Swift package against the iPhoneSimulator SDK.
    #[cfg(target_os = "macos")]
    {
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
            use swift_rs::SwiftLinker;
            // The macOS minimum (Swift runtime + CryptoKit); keep in step with
            // swift-lib/Package.swift and `bundle.macOS.minimumSystemVersion` in
            // the app's tauri.conf.json. Passkeys themselves are gated at runtime.
            SwiftLinker::new("10.15")
                .with_package("PasskeyBridge", "swift-lib")
                .link();
        }
    }

    // Registers the plugin + its command permissions with the Tauri build system,
    // and wires up the mobile plugins' native projects.
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .android_path("android")
        .build();
}
