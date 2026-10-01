/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Commands exposed to the webview; must match the `#[tauri::command]`s in
// src/commands.rs and be listed in permissions/default.toml.
const COMMANDS: &[&str] = &["register", "authenticate", "is_available"];

fn main() {
    // Compile + link the shared Swift ceremony as a static lib on macOS (swift-rs).
    // iOS builds link the same Swift through the Tauri mobile plugin bridge instead.
    #[cfg(target_os = "macos")]
    {
        use swift_rs::SwiftLinker;
        SwiftLinker::new("15.0")
            .with_package("PasskeyBridge", "swift-lib")
            .link();
    }

    // Registers the plugin + its command permissions with the Tauri build system,
    // and (on iOS) wires up the mobile plugin's native project.
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
