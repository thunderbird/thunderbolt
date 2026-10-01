/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The user dismissed the OS passkey sheet. Callers treat this as a no-op,
    /// mirroring the web ceremony's `NotAllowedError`/`ERROR_CEREMONY_ABORTED`.
    #[error("passkey ceremony cancelled")]
    Cancelled,
    /// The ceremony ran but the OS returned an error (no credential, etc.).
    #[error("passkey ceremony failed: {0}")]
    Ceremony(String),
    /// Passkeys aren't available on this OS/version.
    #[error("passkeys are not available on this platform")]
    Unavailable,
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

// Serialize as a plain string so the webview receives a message it can classify
// (the JS adapter maps "cancelled" back to a silent no-op).
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
