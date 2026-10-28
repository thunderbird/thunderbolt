/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Windows passkey backend: drives the Windows WebAuthn API (`webauthn.dll`, the
//! one Chrome and Edge use), which offers Windows Hello, a phone and security keys.
//! The DLL is loaded at runtime rather than imported, so a Windows build without it
//! still launches and reports `Error::Unavailable`.

use std::marker::PhantomData;
use std::mem::transmute;
use std::ptr::null_mut;
use std::slice;
use std::sync::OnceLock;

use tauri::{plugin::PluginApi, AppHandle, Runtime, Window};
use windows::core::{s, w, HRESULT, HSTRING, PCSTR, PCWSTR};
use windows::Win32::Foundation::{HWND, NTE_USER_CANCELLED};
use windows::Win32::Networking::WindowsWebServices::*;
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
};

use crate::client_data::{base64_url, client_data_json, Ceremony};
use crate::error::{Error, Result};
use crate::models::{AssertionResult, AuthenticateRequest, RegisterRequest, RegistrationResult};

/// The server's challenge lifetime (Better Auth's passkey `MAX_AGE_IN_SECONDS`).
const TIMEOUT_MS: u32 = 5 * 60 * 1000;

pub fn init<R: Runtime>(_app: &AppHandle<R>, _api: PluginApi<R, ()>) -> crate::Result<Passkey<R>> {
    Ok(Passkey(PhantomData))
}

// `fn() -> R` keeps the marker Send + Sync regardless of R, as in desktop.rs.
pub struct Passkey<R: Runtime>(pub(crate) PhantomData<fn() -> R>);

impl<R: Runtime> Passkey<R> {
    pub async fn register(
        &self,
        window: Window<R>,
        req: RegisterRequest,
    ) -> Result<RegistrationResult> {
        let hwnd = window.hwnd()?.0 as isize;
        // The call blocks until the Windows dialog closes.
        tauri::async_runtime::spawn_blocking(move || make_credential(api()?, hwnd, &req)).await?
    }

    pub async fn authenticate(
        &self,
        window: Window<R>,
        req: AuthenticateRequest,
    ) -> Result<AssertionResult> {
        let hwnd = window.hwnd()?.0 as isize;
        tauri::async_runtime::spawn_blocking(move || get_assertion(api()?, hwnd, &req)).await?
    }
}

// `webauthn.dll` entry points (signatures from webauthn.h).
type Proc = unsafe extern "system" fn() -> isize;
type GetApiVersionFn = unsafe extern "system" fn() -> u32;
type MakeCredentialFn = unsafe extern "system" fn(
    HWND,
    *const WEBAUTHN_RP_ENTITY_INFORMATION,
    *const WEBAUTHN_USER_ENTITY_INFORMATION,
    *const WEBAUTHN_COSE_CREDENTIAL_PARAMETERS,
    *const WEBAUTHN_CLIENT_DATA,
    *const WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS,
    *mut *mut WEBAUTHN_CREDENTIAL_ATTESTATION,
) -> HRESULT;
type GetAssertionFn = unsafe extern "system" fn(
    HWND,
    PCWSTR,
    *const WEBAUTHN_CLIENT_DATA,
    *const WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS,
    *mut *mut WEBAUTHN_ASSERTION,
) -> HRESULT;
type FreeCredentialAttestationFn =
    unsafe extern "system" fn(*const WEBAUTHN_CREDENTIAL_ATTESTATION);
type FreeAssertionFn = unsafe extern "system" fn(*const WEBAUTHN_ASSERTION);
type GetErrorNameFn = unsafe extern "system" fn(HRESULT) -> PCWSTR;

struct Api {
    version: u32,
    make_credential: MakeCredentialFn,
    get_assertion: GetAssertionFn,
    free_credential_attestation: FreeCredentialAttestationFn,
    free_assertion: FreeAssertionFn,
    get_error_name: GetErrorNameFn,
}

fn api() -> Result<&'static Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(|| unsafe { load_api() })
        .as_ref()
        .ok_or(Error::Unavailable)
}

unsafe fn load_api() -> Option<Api> {
    let module = LoadLibraryExW(w!("webauthn.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
    let proc = |name: PCSTR| GetProcAddress(module, name);
    Some(Api {
        version: transmute::<Proc, GetApiVersionFn>(proc(s!("WebAuthNGetApiVersionNumber"))?)(),
        make_credential: transmute::<Proc, MakeCredentialFn>(proc(s!(
            "WebAuthNAuthenticatorMakeCredential"
        ))?),
        get_assertion: transmute::<Proc, GetAssertionFn>(proc(s!(
            "WebAuthNAuthenticatorGetAssertion"
        ))?),
        free_credential_attestation: transmute::<Proc, FreeCredentialAttestationFn>(proc(s!(
            "WebAuthNFreeCredentialAttestation"
        ))?),
        free_assertion: transmute::<Proc, FreeAssertionFn>(proc(s!("WebAuthNFreeAssertion"))?),
        get_error_name: transmute::<Proc, GetErrorNameFn>(proc(s!("WebAuthNGetErrorName"))?),
    })
}

/// The newest make-credential options version the installed DLL accepts (webauthn.h
/// lists the struct versions each API version adds). `bEnablePrf` needs 6.
fn make_credential_options_version(api_version: u32) -> u32 {
    match api_version {
        0..=2 => WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_VERSION_3,
        3 => WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_VERSION_4,
        4 | 5 => WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_VERSION_5,
        6 => WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_VERSION_6,
        _ => WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_VERSION_7,
    }
}

/// The same for get-assertion options. `pHmacSecretSaltValues` needs 6.
fn get_assertion_options_version(api_version: u32) -> u32 {
    match api_version {
        0..=2 => WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_VERSION_4,
        3 => WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_VERSION_5,
        4..=6 => WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_VERSION_6,
        _ => WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_VERSION_7,
    }
}

/// Owns a `WEBAUTHN_CREDENTIAL_LIST` and the buffers it points into. The pointers
/// target Vec heap buffers, which stay put when the struct moves.
struct CredentialList {
    _ids: Vec<Vec<u8>>,
    _entries: Vec<WEBAUTHN_CREDENTIAL_EX>,
    _pointers: Vec<*mut WEBAUTHN_CREDENTIAL_EX>,
    list: WEBAUTHN_CREDENTIAL_LIST,
}

impl CredentialList {
    fn new(ids: &[Vec<u8>]) -> Self {
        let mut ids = ids.to_vec();
        let mut entries: Vec<_> = ids
            .iter_mut()
            .map(|id| WEBAUTHN_CREDENTIAL_EX {
                dwVersion: WEBAUTHN_CREDENTIAL_EX_CURRENT_VERSION,
                cbId: id.len() as u32,
                pbId: id.as_mut_ptr(),
                pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
                dwTransports: 0,
            })
            .collect();
        let mut pointers: Vec<_> = entries.iter_mut().map(|entry| entry as *mut _).collect();
        let list = WEBAUTHN_CREDENTIAL_LIST {
            cCredentials: pointers.len() as u32,
            ppCredentials: pointers.as_mut_ptr(),
        };
        Self {
            _ids: ids,
            _entries: entries,
            _pointers: pointers,
            list,
        }
    }

    /// The list, or null when empty: no allow list means a discoverable sign-in.
    fn as_mut_ptr(&mut self) -> *mut WEBAUTHN_CREDENTIAL_LIST {
        if self.list.cCredentials == 0 {
            null_mut()
        } else {
            &mut self.list
        }
    }
}

fn client_data(json: &mut [u8]) -> WEBAUTHN_CLIENT_DATA {
    WEBAUTHN_CLIENT_DATA {
        dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
        cbClientDataJSON: json.len() as u32,
        pbClientDataJSON: json.as_mut_ptr(),
        pwszHashAlgId: WEBAUTHN_HASH_ALGORITHM_SHA_256,
    }
}

fn credential_parameter(alg: i32) -> WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
    WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
        dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
        pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
        lAlg: alg,
    }
}

/// Copies `len` bytes the DLL returned; empty for a null pointer.
unsafe fn copy_bytes(ptr: *const u8, len: u32) -> Vec<u8> {
    if ptr.is_null() || len == 0 {
        Vec::new()
    } else {
        slice::from_raw_parts(ptr, len as usize).to_vec()
    }
}

// The API reports a dismissed dialog, a timeout and "no passkey" all as
// NotAllowedError, as browsers do, so all of them read as a cancel.
fn ceremony_error(api: &Api, hr: HRESULT) -> Error {
    if hr == NTE_USER_CANCELLED {
        return Error::Cancelled;
    }
    let name = unsafe { (api.get_error_name)(hr).to_string() }.unwrap_or_default();
    if name == "NotAllowedError" {
        Error::Cancelled
    } else {
        Error::Ceremony(format!("{name} ({:#010x})", hr.0))
    }
}

fn make_credential(api: &Api, hwnd: isize, req: &RegisterRequest) -> Result<RegistrationResult> {
    let rp_id = HSTRING::from(req.rp_id.as_str());
    let user_name = HSTRING::from(req.user_name.as_str());
    let rp = WEBAUTHN_RP_ENTITY_INFORMATION {
        dwVersion: WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
        pwszId: PCWSTR(rp_id.as_ptr()),
        pwszName: PCWSTR(rp_id.as_ptr()),
        pwszIcon: PCWSTR::null(),
    };
    let mut user_id = req.user_id.clone();
    let user = WEBAUTHN_USER_ENTITY_INFORMATION {
        dwVersion: WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
        cbId: user_id.len() as u32,
        pbId: user_id.as_mut_ptr(),
        pwszName: PCWSTR(user_name.as_ptr()),
        pwszIcon: PCWSTR::null(),
        pwszDisplayName: PCWSTR(user_name.as_ptr()),
    };
    let mut parameters = [
        credential_parameter(WEBAUTHN_COSE_ALGORITHM_ECDSA_P256_WITH_SHA256),
        credential_parameter(WEBAUTHN_COSE_ALGORITHM_RSASSA_PKCS1_V1_5_WITH_SHA256),
    ];
    let credential_parameters = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS {
        cCredentialParameters: parameters.len() as u32,
        pCredentialParameters: parameters.as_mut_ptr(),
    };
    let client_data_json = client_data_json(Ceremony::Create, &req.challenge, &req.rp_id);
    let mut client_data_bytes = client_data_json.clone().into_bytes();
    let client_data = client_data(&mut client_data_bytes);
    let mut exclude = CredentialList::new(&req.exclude_credentials);
    // PRF is only switched on here: the API version the `windows` crate binds can't
    // evaluate it at creation, so the app reads the output with a follow-up assertion.
    let options = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS {
        dwVersion: make_credential_options_version(api.version),
        dwTimeoutMilliseconds: TIMEOUT_MS,
        dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY,
        bRequireResidentKey: true.into(),
        dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
        dwAttestationConveyancePreference: WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE,
        pExcludeCredentialList: exclude.as_mut_ptr(),
        bEnablePrf: (!req.prf_salt.is_empty()).into(),
        ..Default::default()
    };

    let mut attestation = null_mut();
    let hr = unsafe {
        (api.make_credential)(
            HWND(hwnd as _),
            &rp,
            &user,
            &credential_parameters,
            &client_data,
            &options,
            &mut attestation,
        )
    };
    if hr.is_err() || attestation.is_null() {
        return Err(ceremony_error(api, hr));
    }
    let result = unsafe {
        let created = &*attestation;
        let credential_id = base64_url(&copy_bytes(created.pbCredentialId, created.cbCredentialId));
        RegistrationResult {
            id: credential_id.clone(),
            raw_id: credential_id,
            client_data_json: base64_url(client_data_json.as_bytes()),
            attestation_object: base64_url(&copy_bytes(
                created.pbAttestationObject,
                created.cbAttestationObject,
            )),
            prf_output: String::new(),
        }
    };
    unsafe { (api.free_credential_attestation)(attestation) };
    Ok(result)
}

fn get_assertion(api: &Api, hwnd: isize, req: &AuthenticateRequest) -> Result<AssertionResult> {
    let rp_id = HSTRING::from(req.rp_id.as_str());
    let client_data_json = client_data_json(Ceremony::Get, &req.challenge, &req.rp_id);
    let mut client_data_bytes = client_data_json.clone().into_bytes();
    let client_data = client_data(&mut client_data_bytes);
    let mut allow = CredentialList::new(&req.allow_credentials);
    // Without the RAW flag, Windows hashes the salt as the PRF extension does, so
    // the output matches what a browser or the other apps get for this passkey.
    let mut salt = req.prf_salt.clone();
    let mut global_salt = WEBAUTHN_HMAC_SECRET_SALT {
        cbFirst: salt.len() as u32,
        pbFirst: salt.as_mut_ptr(),
        ..Default::default()
    };
    let mut salt_values = WEBAUTHN_HMAC_SECRET_SALT_VALUES {
        pGlobalHmacSalt: &mut global_salt,
        ..Default::default()
    };
    let options = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS {
        dwVersion: get_assertion_options_version(api.version),
        dwTimeoutMilliseconds: TIMEOUT_MS,
        dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY,
        dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
        pAllowCredentialList: allow.as_mut_ptr(),
        pHmacSecretSaltValues: if salt.is_empty() {
            null_mut()
        } else {
            &mut salt_values
        },
        ..Default::default()
    };

    let mut assertion = null_mut();
    let hr = unsafe {
        (api.get_assertion)(
            HWND(hwnd as _),
            PCWSTR(rp_id.as_ptr()),
            &client_data,
            &options,
            &mut assertion,
        )
    };
    if hr.is_err() || assertion.is_null() {
        return Err(ceremony_error(api, hr));
    }
    let result = unsafe {
        let signed = &*assertion;
        let credential_id = base64_url(&copy_bytes(signed.Credential.pbId, signed.Credential.cbId));
        // `pHmacSecret` only exists from assertion version 3 on.
        let prf =
            if signed.dwVersion >= WEBAUTHN_ASSERTION_VERSION_3 && !signed.pHmacSecret.is_null() {
                let secret = &*signed.pHmacSecret;
                copy_bytes(secret.pbFirst, secret.cbFirst)
            } else {
                Vec::new()
            };
        AssertionResult {
            id: credential_id.clone(),
            raw_id: credential_id,
            client_data_json: base64_url(client_data_json.as_bytes()),
            authenticator_data: base64_url(&copy_bytes(
                signed.pbAuthenticatorData,
                signed.cbAuthenticatorData,
            )),
            signature: base64_url(&copy_bytes(signed.pbSignature, signed.cbSignature)),
            user_handle: base64_url(&copy_bytes(signed.pbUserId, signed.cbUserId)),
            prf_output: base64_url(&prf),
        }
    };
    unsafe { (api.free_assertion)(assertion) };
    Ok(result)
}
