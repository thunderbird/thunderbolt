/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Mobile passkey backends, both through the Tauri mobile plugin bridge: the
//! Swift plugin (`ios/Sources/PasskeyPlugin`) runs `ASAuthorizationController`
//! like macOS, and the Kotlin plugin (`android/.../PasskeyPlugin.kt`) runs
//! Credential Manager. Both take the same request and return the base64url fields
//! the webview assembles into a WebAuthn response JSON.

use tauri::{
    plugin::{
        mobile::{ErrorResponse, PluginInvokeError},
        PluginApi, PluginHandle,
    },
    AppHandle, Runtime, Window,
};

use crate::error::{Error, Result};
use crate::models::{AssertionResult, AuthenticateRequest, RegisterRequest, RegistrationResult};

// Links the Swift plugin registered as `PasskeyPlugin` (see ios/Sources).
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_passkey);

/// The code both native plugins reject a dismissed sheet with.
const CANCELLED_CODE: &str = "cancelled";

pub fn init<R: Runtime>(_app: &AppHandle<R>, api: PluginApi<R, ()>) -> crate::Result<Passkey<R>> {
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_passkey);
    #[cfg(target_os = "android")]
    let handle =
        api.register_android_plugin("net.thunderbird.thunderbolt.passkey", "PasskeyPlugin");
    let handle = handle.map_err(|err| Error::Ceremony(err.to_string()))?;
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
            .run_mobile_plugin_async("register", req)
            .await
            .map_err(map_plugin_error)
    }

    pub async fn authenticate(
        &self,
        _window: Window<R>,
        req: AuthenticateRequest,
    ) -> Result<AssertionResult> {
        self.0
            .run_mobile_plugin_async("authenticate", req)
            .await
            .map_err(map_plugin_error)
    }
}

fn map_plugin_error(err: PluginInvokeError) -> Error {
    match err {
        PluginInvokeError::InvokeRejected(ErrorResponse {
            code: Some(code), ..
        }) if code == CANCELLED_CODE => Error::Cancelled,
        err => Error::Ceremony(err.to_string()),
    }
}
