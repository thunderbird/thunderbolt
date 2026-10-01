/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! The native bridge speaks in already-decoded bytes, not WebAuthn JSON: the
//! webview-side adapter (`guest-js/index.ts`) decodes the server's
//! `PublicKeyCredentialCreationOptionsJSON` / `RequestOptionsJSON` (base64url →
//! bytes) before calling in, and re-assembles the standard response JSON from the
//! fields below. Keeping the mapping in TS — which we own and can iterate without
//! a native rebuild — is what lets the native layer stay a thin, PRF-agnostic pipe.

use serde::{Deserialize, Serialize};

/// A passkey registration (create) request. `prf_salt` empty ⇒ PRF extension omitted.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub rp_id: String,
    pub challenge: Vec<u8>,
    pub user_id: Vec<u8>,
    pub user_name: String,
    pub user_display_name: String,
    #[serde(default)]
    pub prf_salt: Vec<u8>,
}

/// A passkey authentication (get) request. `allow_credentials` empty ⇒ discoverable
/// (usernameless) sign-in. `prf_salt` empty ⇒ PRF extension omitted.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateRequest {
    pub rp_id: String,
    pub challenge: Vec<u8>,
    #[serde(default)]
    pub allow_credentials: Vec<Vec<u8>>,
    #[serde(default)]
    pub prf_salt: Vec<u8>,
}

/// Native registration result. All byte fields are base64url (no padding), ready to
/// drop into a `RegistrationResponseJSON`. `prf_output` is base64url or empty.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationResult {
    pub id: String,
    pub raw_id: String,
    pub client_data_json: String,
    pub attestation_object: String,
    pub prf_output: String,
}

/// Native assertion result, base64url fields for an `AuthenticationResponseJSON`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssertionResult {
    pub id: String,
    pub raw_id: String,
    pub client_data_json: String,
    pub authenticator_data: String,
    pub signature: String,
    pub user_handle: String,
    pub prf_output: String,
}
