/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const COMMANDS: &[&str] = &[
    "capabilities",
    "create",
    "present",
    "navigate",
    "action",
    "state",
    "close",
    "snapshot",
    "set_picker",
    "poll_picker",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .android_path("android")
        .build();
}
