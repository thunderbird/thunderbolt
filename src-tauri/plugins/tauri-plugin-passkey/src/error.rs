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
    /// The ceremony ran but the OS returned an error (domain not associated, etc.).
    #[error("passkey ceremony failed: {0}")]
    Ceremony(String),
    /// Passkeys aren't available on this OS/version.
    #[error("passkeys are not available on this platform")]
    Unavailable,
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

impl Error {
    /// The stable code the webview branches on; the message is for logs only.
    fn code(&self) -> &'static str {
        match self {
            Error::Cancelled => "cancelled",
            Error::Unavailable => "unavailable",
            Error::Ceremony(_) | Error::Tauri(_) => "failed",
        }
    }
}

/// What the webview receives (`NativePasskeyError` in src/lib/passkey-native.ts).
#[derive(Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        ErrorPayload {
            code: self.code(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

pub type Result<T> = std::result::Result<T, Error>;
