// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::Result;
use thunderbolt_lib::create_app;

// CHANGE: Desktop now calls the same entry `run()` used by mobile.
// WHY: Single bootstrap path = fewer divergences and easier maintenance.
// Also removes the unnecessary Tokio runtime here (the Tauri runtime manages it).
fn main() {
    thunderbolt_lib::run();
}
