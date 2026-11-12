/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import CryptoKit
import Foundation

struct E2EEContext: Sendable, Equatable {
    let table: String
    let column: String
    let rowID: String
}

protocol E2EEKeyProviding: Sendable {
    func isEncryptionConfigured() async throws -> Bool
    func primaryKeyID() async throws -> String?
    func dataKey(for keyID: String) async throws -> Data?
}

actor ThunderboltColumnCodec {
    private let keys: any E2EEKeyProviding
    private let prefix = "__enc:"
    private let v2Prefix = "__enc:v2:"

    init(keys: any E2EEKeyProviding) {
        self.keys = keys
    }

    func isEncryptionConfigured() async throws -> Bool {
        try await keys.isEncryptionConfigured()
    }

    func isReadyForSync() async throws -> Bool {
        guard try await keys.isEncryptionConfigured(),
              let keyID = try await keys.primaryKeyID(),
              ThunderboltCrypto.isMintableKeyIDForCodec(keyID),
              let key = try await keys.dataKey(for: keyID), key.count == 32 else { return false }
        return true
    }

    nonisolated func isEncryptedValue(_ value: String) -> Bool {
        value.hasPrefix("__enc:")
    }

    nonisolated func isValidV2Ciphertext(_ value: String) -> Bool {
        guard let parsed = Self.parse(value), parsed.v2,
              let iv = Data(base64Encoded: parsed.iv), iv.count == 12,
              let ciphertext = Data(base64Encoded: parsed.ciphertext), ciphertext.count >= 16 else { return false }
        return true
    }

    func encode(_ plaintext: String, context: E2EEContext) async throws -> String {
        guard try await keys.isEncryptionConfigured() else {
            guard try await keys.primaryKeyID() == nil else { throw CryptoFailure.keyConfigurationIncomplete }
            return plaintext
        }
        guard let keyID = try await keys.primaryKeyID(), ThunderboltCrypto.isMintableKeyIDForCodec(keyID),
              let keyBytes = try await keys.dataKey(for: keyID), keyBytes.count == 32 else {
            throw CryptoFailure.keyConfigurationIncomplete
        }
        let nonceData = try ThunderboltCrypto.randomBytes(count: 12)
        let aad = Data([context.table, context.column, context.rowID, keyID].joined(separator: "\u{001f}").utf8)
        let box = try AES.GCM.seal(Data(plaintext.utf8), using: SymmetricKey(data: keyBytes), nonce: AES.GCM.Nonce(data: nonceData), authenticating: aad)
        return "\(v2Prefix)\(keyID):\(nonceData.base64EncodedString()):\((box.ciphertext + box.tag).base64EncodedString())"
    }

    func decode(_ encoded: String, context: E2EEContext?) async throws -> String {
        guard encoded.hasPrefix(prefix) else { return encoded }
        guard let parsed = Self.parse(encoded) else { return encoded }
        let resolvedKey: Data?
        do { resolvedKey = try await keys.dataKey(for: parsed.keyID) }
        catch { return encoded }
        guard let keyBytes = resolvedKey, keyBytes.count == 32 else { return encoded }
        guard let iv = Data(base64Encoded: parsed.iv), iv.count == 12,
              let blob = Data(base64Encoded: parsed.ciphertext), blob.count >= 16 else { return encoded }
        do {
            let box: AES.GCM.SealedBox
            if parsed.v2 {
                guard let context else { return encoded }
                let aad = Data([context.table, context.column, context.rowID, parsed.keyID].joined(separator: "\u{001f}").utf8)
                box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: Data(blob.dropLast(16)), tag: Data(blob.suffix(16)))
                guard let plaintext = try? AES.GCM.open(box, using: SymmetricKey(data: keyBytes), authenticating: aad),
                      let text = String(data: plaintext, encoding: .utf8) else { return encoded }
                return text
            }
            box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: Data(blob.dropLast(16)), tag: Data(blob.suffix(16)))
            guard let plaintext = try? AES.GCM.open(box, using: SymmetricKey(data: keyBytes)),
                  let text = String(data: plaintext, encoding: .utf8) else { return encoded }
            return text
        } catch {
            return encoded
        }
    }

    private static func parse(_ value: String) -> (v2: Bool, keyID: String, iv: String, ciphertext: String)? {
        let pieces = value.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        if pieces.count == 5, pieces[0] == "__enc", pieces[1] == "v2",
           ThunderboltCrypto.isWireKeyIDForCodec(pieces[2]) {
            return (true, pieces[2], pieces[3], pieces[4])
        }
        if pieces.count == 3, pieces[0] == "__enc" {
            return (false, "v1", pieces[1], pieces[2])
        }
        return nil
    }
}

extension ThunderboltColumnCodec: NativeSyncRowCodec {}
