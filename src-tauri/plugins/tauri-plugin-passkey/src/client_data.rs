/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! The Windows API takes clientDataJSON from the caller instead of building it,
//! so the plugin builds it here, the way a browser does.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;

/// The WebAuthn ceremony a clientDataJSON belongs to.
#[derive(Clone, Copy)]
pub(crate) enum Ceremony {
    Create,
    Get,
}

/// Base64url without padding, as WebAuthn JSON encodes bytes.
pub(crate) fn base64_url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

// Field order follows the spec's serialization, as browsers send it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CollectedClientData<'a> {
    r#type: &'a str,
    challenge: String,
    origin: String,
    cross_origin: bool,
}

/// The clientDataJSON for a ceremony. The origin is `https://{rp_id}`, the same
/// origin the Apple apps present, so the server needs no extra trusted origin.
pub(crate) fn client_data_json(ceremony: Ceremony, challenge: &[u8], rp_id: &str) -> String {
    let data = CollectedClientData {
        r#type: match ceremony {
            Ceremony::Create => "webauthn.create",
            Ceremony::Get => "webauthn.get",
        },
        challenge: base64_url(challenge),
        origin: format!("https://{rp_id}"),
        cross_origin: false,
    };
    serde_json::to_string(&data).expect("client data always serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_create_client_data_in_spec_order() {
        assert_eq!(
            client_data_json(Ceremony::Create, &[0xfb, 0xff, 0x01], "app.thunderbolt.io"),
            r#"{"type":"webauthn.create","challenge":"-_8B","origin":"https://app.thunderbolt.io","crossOrigin":false}"#
        );
    }

    #[test]
    fn builds_get_client_data() {
        assert_eq!(
            client_data_json(Ceremony::Get, b"hi", "example.com"),
            r#"{"type":"webauthn.get","challenge":"aGk","origin":"https://example.com","crossOrigin":false}"#
        );
    }

    #[test]
    fn encodes_base64_url_without_padding() {
        assert_eq!(base64_url(&[]), "");
        assert_eq!(base64_url(&[0xff, 0xee]), "_-4");
    }
}
