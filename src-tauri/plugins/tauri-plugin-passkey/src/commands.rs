/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use tauri::{command, AppHandle, Runtime, Window};

use crate::error::Result;
use crate::models::{AssertionResult, AuthenticateRequest, RegisterRequest, RegistrationResult};
use crate::PasskeyExt;

#[command]
pub(crate) async fn register<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    request: RegisterRequest,
) -> Result<RegistrationResult> {
    app.passkey().register(window, request).await
}

#[command]
pub(crate) async fn authenticate<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    request: AuthenticateRequest,
) -> Result<AssertionResult> {
    app.passkey().authenticate(window, request).await
}

#[command]
pub(crate) fn is_available<R: Runtime>(app: AppHandle<R>) -> Result<bool> {
    app.passkey().is_available()
}
