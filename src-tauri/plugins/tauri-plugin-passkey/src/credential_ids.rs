/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/// Credential ids for the macOS FFI, each prefixed with its length as two
/// big-endian bytes (`unpackCredentialIDs` in Exports.swift reverses it). WebAuthn
/// caps an id at 1023 bytes, so the length always fits.
pub(crate) fn pack_credential_ids(ids: &[Vec<u8>]) -> Vec<u8> {
    ids.iter()
        .flat_map(|id| {
            (id.len() as u16)
                .to_be_bytes()
                .into_iter()
                .chain(id.iter().copied())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::pack_credential_ids;

    #[test]
    fn packs_each_id_behind_its_length() {
        let ids = vec![vec![1, 2, 3], vec![0xff; 300]];
        let packed = pack_credential_ids(&ids);
        assert_eq!(&packed[..5], &[0, 3, 1, 2, 3]);
        assert_eq!(&packed[5..7], &[0x01, 0x2c]);
        assert_eq!(packed.len(), 5 + 2 + 300);
    }

    #[test]
    fn packs_nothing_for_no_ids() {
        assert!(pack_credential_ids(&[]).is_empty());
    }
}
