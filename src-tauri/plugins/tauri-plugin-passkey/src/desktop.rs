/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! macOS passkey backend: drives `ASAuthorizationController` through a static Swift
//! lib via swift-rs. Structure adapted from yminghua/tauri-plugin-macos-passkey
//! (MIT/Apache); the FFI result fields are already base64url so the webview adapter
//! can drop them straight into a WebAuthn response JSON.

use std::ffi::{c_char, c_void, CStr};
use std::marker::PhantomData;

use swift_rs::{SRData, SRObject, SRString, SwiftArg, SwiftRef};
use tauri::{plugin::PluginApi, AppHandle, Runtime, Window};
use tokio::sync::oneshot;

use crate::credential_ids::pack_credential_ids;
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
        let outcome = start_registration(window.ns_window()?, &req);
        let obj: SRObject<RegistrationResultObject> = take_result(outcome.await)?;
        Ok(RegistrationResult {
            id: obj.id.to_string(),
            raw_id: obj.raw_id.to_string(),
            client_data_json: obj.client_data_json.to_string(),
            attestation_object: obj.attestation_object.to_string(),
            prf_output: obj.prf_output.to_string(),
        })
    }

    pub async fn authenticate(
        &self,
        window: Window<R>,
        req: AuthenticateRequest,
    ) -> Result<AssertionResult> {
        let outcome = start_login(window.ns_window()?, &req);
        let obj: SRObject<LoginResultObject> = take_result(outcome.await)?;
        Ok(AssertionResult {
            id: obj.id.to_string(),
            raw_id: obj.raw_id.to_string(),
            client_data_json: obj.client_data_json.to_string(),
            authenticator_data: obj.authenticator_data.to_string(),
            signature: obj.signature.to_string(),
            user_handle: obj.user_handle.to_string(),
            prf_output: obj.prf_output.to_string(),
        })
    }
}

// --- FFI result layouts (field order must match Exports.swift @objcMembers classes) ---
#[repr(C)]
struct RegistrationResultObject {
    id: SRString,
    raw_id: SRString,
    client_data_json: SRString,
    attestation_object: SRString,
    prf_output: SRString,
}

#[repr(C)]
struct LoginResultObject {
    id: SRString,
    raw_id: SRString,
    client_data_json: SRString,
    authenticator_data: SRString,
    signature: SRString,
    user_handle: SRString,
    prf_output: SRString,
}

// Ceremony status codes; must match `CeremonyStatus` in Exports.swift.
const STATUS_OK: i32 = 0;
const STATUS_CANCELLED: i32 = 1;

type PasskeyResultCallback =
    unsafe extern "C" fn(result: *mut c_void, status: i32, message: *const c_char, context: u64);

// Declared as a plain extern block (not swift-rs's `swift!` macro) because the C
// function-pointer callback isn't a `SwiftArg`. Objects go over as `SwiftRef`s, as
// the macro does, so Rust keeps ownership and releases them after the call.
extern "C" {
    fn begin_passkey_registration(
        window_ptr: *mut c_void,
        domain: SwiftRef<SRString>,
        challenge: SwiftRef<SRData>,
        username: SwiftRef<SRString>,
        user_id: SwiftRef<SRData>,
        exclude_credentials: SwiftRef<SRData>,
        salt: SwiftRef<SRData>,
        context: u64,
        callback: PasskeyResultCallback,
    );

    fn begin_passkey_login(
        window_ptr: *mut c_void,
        domain: SwiftRef<SRString>,
        challenge: SwiftRef<SRData>,
        allow_credentials: SwiftRef<SRData>,
        salt: SwiftRef<SRData>,
        context: u64,
        callback: PasskeyResultCallback,
    );
}

type Outcome = oneshot::Receiver<Result<usize>>;

extern "C" fn passkey_result_callback(
    result: *mut c_void,
    status: i32,
    message: *const c_char,
    context: u64,
) {
    let sender: Box<oneshot::Sender<Result<usize>>> = unsafe { Box::from_raw(context as *mut _) };
    let outcome = match status {
        STATUS_OK => Ok(result as usize),
        STATUS_CANCELLED => Err(Error::Cancelled),
        _ => Err(Error::Ceremony(
            unsafe { CStr::from_ptr(message) }
                .to_string_lossy()
                .into_owned(),
        )),
    };
    // Only fails when the command future was dropped, leaving no one to report to.
    let _ = sender.send(outcome);
}

/// Hand the ceremony to Swift; it returns at once and reports through the callback.
fn start_registration(window_ptr: *mut c_void, req: &RegisterRequest) -> Outcome {
    let (sender, receiver) = oneshot::channel();
    let context = Box::into_raw(Box::new(sender)) as u64;
    let domain = SRString::from(req.rp_id.as_str());
    let challenge = SRData::from(req.challenge.as_slice());
    let username = SRString::from(req.user_name.as_str());
    let user_id = SRData::from(req.user_id.as_slice());
    let exclude_credentials =
        SRData::from(pack_credential_ids(&req.exclude_credentials).as_slice());
    let salt = SRData::from(req.prf_salt.as_slice());
    unsafe {
        begin_passkey_registration(
            window_ptr,
            domain.as_arg(),
            challenge.as_arg(),
            username.as_arg(),
            user_id.as_arg(),
            exclude_credentials.as_arg(),
            salt.as_arg(),
            context,
            passkey_result_callback,
        );
    }
    receiver
}

/// Hand the ceremony to Swift; it returns at once and reports through the callback.
fn start_login(window_ptr: *mut c_void, req: &AuthenticateRequest) -> Outcome {
    let (sender, receiver) = oneshot::channel();
    let context = Box::into_raw(Box::new(sender)) as u64;
    let domain = SRString::from(req.rp_id.as_str());
    let challenge = SRData::from(req.challenge.as_slice());
    let allow_credentials = SRData::from(pack_credential_ids(&req.allow_credentials).as_slice());
    let salt = SRData::from(req.prf_salt.as_slice());
    unsafe {
        begin_passkey_login(
            window_ptr,
            domain.as_arg(),
            challenge.as_arg(),
            allow_credentials.as_arg(),
            salt.as_arg(),
            context,
            passkey_result_callback,
        );
    }
    receiver
}

/// Adopt the +1-retained result object Swift sent back.
fn take_result<T>(
    outcome: std::result::Result<Result<usize>, oneshot::error::RecvError>,
) -> Result<SRObject<T>> {
    let ptr =
        outcome.map_err(|_| Error::Ceremony("passkey bridge dropped the ceremony".into()))??;
    Ok(unsafe { std::mem::transmute::<*mut c_void, SRObject<T>>(ptr as *mut c_void) })
}
