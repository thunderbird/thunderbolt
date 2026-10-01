/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! iOS passkey backend: forwards each ceremony to the native Swift plugin
//! (`ios/Sources/PasskeyPlugin`) through the Tauri mobile plugin bridge. The
//! Swift side runs the same `ASAuthorizationController` flow as macOS, anchored on
//! the app's `UIWindow`, and returns the base64url fields the webview assembles
//! into a WebAuthn response JSON.

use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime, Window,
};

use crate::error::{Error, Result};
use crate::models::{AssertionResult, AuthenticateRequest, RegisterRequest, RegistrationResult};

// Links the Swift plugin registered as `PasskeyPlugin` (see ios/Sources).
tauri::ios_plugin_binding!(init_plugin_passkey);

pub fn init<R: Runtime>(_app: &AppHandle<R>, api: PluginApi<R, ()>) -> crate::Result<Passkey<R>> {
    let handle = api
        .register_ios_plugin(init_plugin_passkey)
        .map_err(Error::Tauri)?;
    Ok(Passkey(handle))
}

pub struct Passkey<R: Runtime>(pub(crate) PluginHandle<R>);

impl<R: Runtime> Passkey<R> {
    pub async fn register(
        &self,
        _window: Window<R>,
        req: RegisterRequest,
    ) -> Result<RegistrationResult> {
        self.0
            .run_mobile_plugin("register", req)
            .map_err(map_plugin_error)
    }

    pub async fn authenticate(
        &self,
        _window: Window<R>,
        req: AuthenticateRequest,
    ) -> Result<AssertionResult> {
        self.0
            .run_mobile_plugin("authenticate", req)
            .map_err(map_plugin_error)
    }

    pub fn is_available(&self) -> Result<bool> {
        self.0
            .run_mobile_plugin("isAvailable", ())
            .map_err(map_plugin_error)
    }
}

/// The Swift plugin rejects a user-cancelled sheet with a known code so the app can
/// treat it as a silent no-op; everything else is a real ceremony error.
fn map_plugin_error(err: tauri::plugin::mobile::PluginInvokeError) -> Error {
    let message = err.to_string();
    if message.contains("cancelled") || message.contains("canceled") {
        Error::Cancelled
    } else {
        Error::Ceremony(message)
    }
}
