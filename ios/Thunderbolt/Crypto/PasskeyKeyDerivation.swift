/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import CryptoKit
import Foundation

/// The PRF-derived virtual device keypair shared with the web and Tauri clients.
/// The PRF output is an ephemeral input and must never be persisted or sent to the server.
enum ThunderboltPasskeyCrypto {
    static func deriveDeviceKeys(prfOutput: Data) throws -> ThunderboltDeviceKeys {
        guard prfOutput.count == 32 else { throw CryptoFailure.invalidKey }

        let ecdhSeed = hkdf(
            input: prfOutput,
            info: Data("thunderbolt-passkey-ecdh-v1".utf8),
            count: 48
        )
        guard let ecdhScalar = Data(base64Encoded: try NobleCryptoBridge.shared.invoke("p256Scalar", [ecdhSeed.base64EncodedString()])),
              ecdhScalar.count == 32 else { throw CryptoFailure.derivationFailed }

        let mlkemSeed = hkdf(
            input: prfOutput,
            info: Data("thunderbolt-passkey-mlkem-v1".utf8),
            count: 64
        )
        let json = try NobleCryptoBridge.shared.invoke("keygen", [mlkemSeed.base64EncodedString()])
        guard let bytes = json.data(using: .utf8),
              let kem = try JSONSerialization.jsonObject(with: bytes) as? [String: String] else {
            throw CryptoFailure.bridge("Invalid passkey keypair response")
        }
        guard let publicKey = Data(base64Encoded: kem["publicKey"] ?? ""),
              let secretKey = Data(base64Encoded: kem["secretKey"] ?? "") else {
            throw CryptoFailure.bridge("Invalid passkey ML-KEM keypair")
        }
        let privateKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: ecdhScalar)
        return ThunderboltDeviceKeys(
            ecdhPrivateKeyRaw: privateKey.rawRepresentation,
            mlkemSecretKey: secretKey,
            mlkemPublicKey: publicKey
        )
    }

    private static func hkdf(input: Data, info: Data, count: Int) -> Data {
        HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: input),
            salt: Data(),
            info: info,
            outputByteCount: count
        ).withUnsafeBytes { Data($0) }
    }
}
