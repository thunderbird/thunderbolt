/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "platform-utils",
            tauri_build::InlinedPlugin::new()
                .commands(&["get_android_insets", "set_bar_color"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
