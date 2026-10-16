/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Native WebAuthn passkey ceremonies for Thunderbolt's Tauri apps.
//!
//! The app's webviews don't expose `navigator.credentials` for its RP ID, so
//! passkey register/authenticate must run natively. This plugin runs the ceremony through
//! the OS API and returns the raw material the webview needs to assemble a standard
//! WebAuthn response JSON:
//!
//! - **macOS**: a static Swift lib (swift-rs) driving `ASAuthorizationController`
//!   (`src/desktop.rs` + `swift-lib/`), adapted from yminghua/tauri-plugin-macos-passkey.
//! - **iOS**: the Tauri mobile plugin bridge to the same `AuthenticationServices`
//!   API (`src/mobile.rs` + `ios/`).
//! - **Android**: the same bridge to Credential Manager (`src/mobile.rs` + `android/`).
//! - **other platforms**: every call fails with `Error::Unavailable`; the app never
//!   offers passkeys there.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
#[cfg(any(target_os = "macos", test))]
mod credential_ids;
mod error;
mod models;

pub use error::{Error, Result};
pub use models::*;

#[cfg(target_os = "macos")]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(target_os = "macos")]
use desktop::Passkey;
#[cfg(mobile)]
use mobile::Passkey;

/// Fallback handle for platforms with no native passkey support.
#[cfg(not(any(target_os = "macos", mobile)))]
mod unsupported {
    use std::marker::PhantomData;
    use tauri::{Runtime, Window};

    use crate::error::{Error, Result};
    use crate::models::*;

    // `fn() -> R` keeps the marker Send + Sync regardless of R.
    pub struct Passkey<R: Runtime>(pub(crate) PhantomData<fn() -> R>);

    impl<R: Runtime> Passkey<R> {
        pub async fn register(
            &self,
            _w: Window<R>,
            _r: RegisterRequest,
        ) -> Result<RegistrationResult> {
            Err(Error::Unavailable)
        }
        pub async fn authenticate(
            &self,
            _w: Window<R>,
            _r: AuthenticateRequest,
        ) -> Result<AssertionResult> {
            Err(Error::Unavailable)
        }
    }
}
#[cfg(not(any(target_os = "macos", mobile)))]
use unsupported::Passkey;

/// Access to the passkey APIs, added to `AppHandle`/`Window`/`App` by the plugin.
pub trait PasskeyExt<R: Runtime> {
    fn passkey(&self) -> &Passkey<R>;
}

impl<R: Runtime, T: Manager<R>> PasskeyExt<R> for T {
    fn passkey(&self) -> &Passkey<R> {
        self.state::<Passkey<R>>().inner()
    }
}

/// Initialize the passkey plugin. Add to the Tauri builder with `.plugin(init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("passkey")
        .invoke_handler(tauri::generate_handler![
            commands::register,
            commands::authenticate,
        ])
        .setup(|app, _api| {
            #[cfg(target_os = "macos")]
            let passkey = desktop::init(app, _api)?;
            #[cfg(mobile)]
            let passkey = mobile::init(app, _api)?;
            #[cfg(not(any(target_os = "macos", mobile)))]
            let passkey = Passkey::<R>(std::marker::PhantomData);

            app.manage(passkey);
            Ok(())
        })
        .build()
}
