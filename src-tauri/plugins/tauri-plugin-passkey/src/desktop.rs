/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! macOS passkey backend: drives `ASAuthorizationController` through a static Swift
//! lib via swift-rs. Structure adapted from yminghua/tauri-plugin-macos-passkey
//! (MIT/Apache); the FFI result fields are already base64url so the webview adapter
//! can drop them straight into a WebAuthn response JSON.
//!
//! TODO(passkey): `allowCredentials` is not yet threaded to the assertion request —
//! macOS sign-in is discoverable (usernameless) only for now. Add it alongside the
//! Swift `createCredentialAssertionRequest(...).allowedCredentials` set.

use std::ffi::c_void;

use std::marker::PhantomData;

use futures::executor::block_on;
use swift_rs::{SRData, SRObject, SRString};
use tauri::{async_runtime::spawn_blocking, plugin::PluginApi, AppHandle, Runtime, Window};
use tokio::sync::oneshot;

use crate::error::{Error, Result};
use crate::models::{AssertionResult, AuthenticateRequest, RegisterRequest, RegistrationResult};

pub fn init<R: Runtime>(_app: &AppHandle<R>, _api: PluginApi<R, ()>) -> crate::Result<Passkey<R>> {
    Ok(Passkey(PhantomData))
}

// `fn() -> R` keeps the marker Send + Sync regardless of R, so the handle can be
// managed as Tauri state without bounding R on Send/Sync.
pub struct Passkey<R: Runtime>(pub(crate) PhantomData<fn() -> R>);

impl<R: Runtime> Passkey<R> {
    pub async fn register(
        &self,
        window: Window<R>,
        req: RegisterRequest,
    ) -> Result<RegistrationResult> {
        let window_ptr = window.ns_window().map_err(Error::Tauri)? as usize;
        spawn_blocking(move || run_registration(window_ptr as *mut c_void, &req))
            .await
            .map_err(|e| Error::Ceremony(e.to_string()))?
    }

    pub async fn authenticate(
        &self,
        window: Window<R>,
        req: AuthenticateRequest,
    ) -> Result<AssertionResult> {
        let window_ptr = window.ns_window().map_err(Error::Tauri)? as usize;
        spawn_blocking(move || run_login(window_ptr as *mut c_void, &req))
            .await
            .map_err(|e| Error::Ceremony(e.to_string()))?
    }

    pub fn is_available(&self) -> Result<bool> {
        // Platform passkeys require macOS 13+; PRF requires 15+. The Swift side
        // guards `#available(macOS 15, *)`, so treat the whole thing as available
        // on macOS and let the ceremony fail gracefully on older systems.
        Ok(true)
    }
}

// --- FFI result layouts (must match Exports.swift @objcMembers classes) ---
#[allow(non_snake_case)]
#[repr(C)]
struct RegistrationResultObject {
    id: SRString,
    rawId: SRString,
    clientDataJSON: SRString,
    attestationObject: SRString,
    prfOutput: SRData,
}

#[allow(non_snake_case)]
#[repr(C)]
struct LoginResultObject {
    id: SRString,
    rawId: SRString,
    clientDataJSON: SRString,
    authenticatorData: SRString,
    signature: SRString,
    userHandle: SRString,
    prfOutput: SRData,
}

type PasskeyResultCallback = unsafe extern "C" fn(result: *mut c_void, context: u64);

// Declared as a plain extern block (not swift-rs's `swift!` macro) because the C
// function-pointer callback isn't a `SwiftArg`. The Swift side exports these via
// `@_cdecl` (swift-lib/Sources/PasskeyBridge/Exports.swift).
extern "C" {
    fn begin_passkey_registration(
        window_ptr: *mut c_void,
        domain: SRString,
        challenge: SRData,
        username: SRString,
        user_id: SRData,
        salt: SRData,
        context: u64,
        callback: PasskeyResultCallback,
    );

    fn begin_passkey_login(
        window_ptr: *mut c_void,
        domain: SRString,
        challenge: SRData,
        salt: SRData,
        context: u64,
        callback: PasskeyResultCallback,
    );
}

extern "C" fn passkey_result_callback(result: *mut c_void, context: u64) {
    let sender: Box<oneshot::Sender<usize>> = unsafe { Box::from_raw(context as *mut _) };
    let _ = sender.send(result as usize);
}

fn prf_string(data: &SRData) -> String {
    // Swift already base64url-encodes PRF output before boxing; empty ⇒ no PRF.
    // The bytes here are the encoded ASCII, so decode losslessly as UTF-8.
    String::from_utf8_lossy(data.as_slice()).into_owned()
}

fn run_registration(window_ptr: *mut c_void, req: &RegisterRequest) -> Result<RegistrationResult> {
    let (sender, receiver) = oneshot::channel::<usize>();
    let context = Box::into_raw(Box::new(sender)) as u64;
    unsafe {
        begin_passkey_registration(
            window_ptr,
            SRString::from(req.rp_id.as_str()),
            SRData::from(req.challenge.as_slice()),
            SRString::from(req.user_name.as_str()),
            SRData::from(req.user_id.as_slice()),
            SRData::from(req.prf_salt.as_slice()),
            context,
            passkey_result_callback,
        );
    }
    let ptr = block_on(receiver).map_err(|_| Error::Ceremony("channel closed".into()))?;
    if ptr == 0 {
        return Err(Error::Cancelled);
    }
    let obj: SRObject<RegistrationResultObject> =
        unsafe { std::mem::transmute(ptr as *mut c_void) };
    Ok(RegistrationResult {
        id: obj.id.to_string(),
        raw_id: obj.rawId.to_string(),
        client_data_json: obj.clientDataJSON.to_string(),
        attestation_object: obj.attestationObject.to_string(),
        prf_output: prf_string(&obj.prfOutput),
    })
}

fn run_login(window_ptr: *mut c_void, req: &AuthenticateRequest) -> Result<AssertionResult> {
    let (sender, receiver) = oneshot::channel::<usize>();
    let context = Box::into_raw(Box::new(sender)) as u64;
    unsafe {
        begin_passkey_login(
            window_ptr,
            SRString::from(req.rp_id.as_str()),
            SRData::from(req.challenge.as_slice()),
            SRData::from(req.prf_salt.as_slice()),
            context,
            passkey_result_callback,
        );
    }
    let ptr = block_on(receiver).map_err(|_| Error::Ceremony("channel closed".into()))?;
    if ptr == 0 {
        return Err(Error::Cancelled);
    }
    let obj: SRObject<LoginResultObject> = unsafe { std::mem::transmute(ptr as *mut c_void) };
    Ok(AssertionResult {
        id: obj.id.to_string(),
        raw_id: obj.rawId.to_string(),
        client_data_json: obj.clientDataJSON.to_string(),
        authenticator_data: obj.authenticatorData.to_string(),
        signature: obj.signature.to_string(),
        user_handle: obj.userHandle.to_string(),
        prf_output: prf_string(&obj.prfOutput),
    })
}
