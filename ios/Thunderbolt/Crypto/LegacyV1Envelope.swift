/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import CommonCrypto
import CryptoKit
import Foundation

/// The only supported reader for legacy v1 device envelopes. New writes must use
/// the v2/v3 account-key envelope and must never create this format.
enum LegacyV1Envelope {
    private static let ephemeralPublicKeyLength = 65
    private static let mlkemCiphertextLength = 1088

    static func unwrapContentKey(_ wrappedBase64: String, deviceKeys: ThunderboltDeviceKeys) throws -> Data {
        guard let envelope = Data(base64Encoded: wrappedBase64),
              envelope.count == 1 + ephemeralPublicKeyLength + mlkemCiphertextLength + 40,
              envelope.first == 0x01 else { throw CryptoFailure.malformedValue }

        let ephemeralStart = 1
        let kemStart = ephemeralStart + ephemeralPublicKeyLength
        let wrappedKeyStart = kemStart + mlkemCiphertextLength
        let ephemeralRaw = Data(envelope[ephemeralStart..<kemStart])
        let kemCiphertext = Data(envelope[kemStart..<wrappedKeyStart])
        let wrappedKey = Data(envelope[wrappedKeyStart...])
        let ephemeralPublicKey = try P256.KeyAgreement.PublicKey(x963Representation: ephemeralRaw)
        let sharedEcdh = try deviceKeys.ecdhPrivateKey.sharedSecretFromKeyAgreement(with: ephemeralPublicKey)
            .withUnsafeBytes { Data($0) }
        guard let sharedMLKEM = Data(base64Encoded: try NobleCryptoBridge.shared.invoke(
            "decapsulate", [kemCiphertext.base64EncodedString(), deviceKeys.mlkemSecretKey.base64EncodedString()]
        )), sharedMLKEM.count == 32 else { throw CryptoFailure.derivationFailed }

        var inputKeyMaterial = sharedEcdh
        inputKeyMaterial.append(sharedMLKEM)
        var transcriptSalt = ephemeralRaw
        transcriptSalt.append(kemCiphertext)
        let wrappingKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: inputKeyMaterial),
            salt: transcriptSalt,
            info: Data("thunderbolt-hybrid-ck-wrap-v1".utf8),
            outputByteCount: 32
        ).withUnsafeBytes { Data($0) }
        let contentKey = try aesKeyUnwrap(wrappedKey, key: wrappingKey)
        guard contentKey.count == 32 else { throw CryptoFailure.malformedValue }
        return contentKey
    }

    /// Recover the D1 proof from the old no-AAD canary. The backend expects the
    /// 64-character lowercase hex secret, not the prefixed plaintext.
    static func recoverPossessionSecret(contentKey: Data, iv: String, ciphertext: String) throws -> String {
        guard contentKey.count == 32,
              let nonce = Data(base64Encoded: iv), nonce.count == 12,
              let sealed = Data(base64Encoded: ciphertext), sealed.count >= 16 else { throw CryptoFailure.malformedValue }
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonce),
            ciphertext: Data(sealed.dropLast(16)),
            tag: Data(sealed.suffix(16))
        )
        let plaintext = try AES.GCM.open(box, using: SymmetricKey(data: contentKey))
        guard let value = String(data: plaintext, encoding: .utf8),
              value.hasPrefix("thunderbolt-canary-v1:"),
              let secret = value.split(separator: ":", maxSplits: 1).last,
              secret.count == 64,
              secret.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { throw CryptoFailure.invalidKey }
        return String(secret)
    }

    /// Check an optional local v1 ciphertext sample against a candidate CK before
    /// the migration absorbs that CK into the permanent `v1` read-only key slot.
    static func opensSample(_ value: String, contentKey: Data) -> Bool {
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "__enc",
              let iv = Data(base64Encoded: String(parts[1])), iv.count == 12,
              let ciphertext = Data(base64Encoded: String(parts[2])), ciphertext.count >= 16,
              contentKey.count == 32 else { return false }
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: iv),
                ciphertext: Data(ciphertext.dropLast(16)),
                tag: Data(ciphertext.suffix(16))
            )
            return (try? AES.GCM.open(box, using: SymmetricKey(data: contentKey))) != nil
        } catch {
            return false
        }
    }

    static func aesKeyUnwrap(_ wrapped: Data, key: Data) throws -> Data {
        guard key.count == 32, wrapped.count >= 24, wrapped.count.isMultiple(of: 8) else { throw CryptoFailure.malformedValue }
        var a = Data(wrapped.prefix(8))
        var blocks = stride(from: 8, to: wrapped.count, by: 8).map { Data(wrapped[$0..<$0 + 8]) }
        for round in (0..<6).reversed() {
            for index in blocks.indices.reversed() {
                let t = UInt64(blocks.count * round + index + 1)
                let block = try aesDecryptBlock(xorCounter(a, t) + blocks[index], key: key)
                a = Data(block.prefix(8))
                blocks[index] = Data(block.suffix(8))
            }
        }
        guard a == Data(repeating: 0xa6, count: 8) else { throw CryptoFailure.invalidKey }
        return blocks.reduce(into: Data()) { $0.append($1) }
    }

    private static func aesDecryptBlock(_ input: Data, key: Data) throws -> Data {
        guard input.count == 16, key.count == 32 else { throw CryptoFailure.invalidKey }
        var output = Data(count: 16)
        var moved = 0
        let outputCount = output.count
        let status = output.withUnsafeMutableBytes { outputBytes in
            input.withUnsafeBytes { inputBytes in
                key.withUnsafeBytes { keyBytes in
                    CCCrypt(
                        CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionECBMode),
                        keyBytes.baseAddress, key.count, nil,
                        inputBytes.baseAddress, input.count, outputBytes.baseAddress, outputCount, &moved
                    )
                }
            }
        }
        guard status == kCCSuccess, moved == 16 else { throw CryptoFailure.derivationFailed }
        return output
    }

    private static func xorCounter(_ block: Data, _ counter: UInt64) -> Data {
        var result = block
        for offset in 0..<8 {
            result[offset] ^= UInt8(truncatingIfNeeded: counter >> UInt64((7 - offset) * 8))
        }
        return result
    }
}
