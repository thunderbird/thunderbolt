/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import CryptoKit
import Foundation
import XCTest
@testable import Thunderbolt

final class LegacyV1EnvelopeTests: XCTestCase {
    func testAESKeyUnwrapMatchesRFC3394Vector() throws {
        let key = Data(hex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
        let wrapped = Data(hex: "64e8c3f9ce0f5ba263e9777905818a2a93c8191e7d6e8ae7")

        XCTAssertEqual(
            try LegacyV1Envelope.aesKeyUnwrap(wrapped, key: key),
            Data(hex: "00112233445566778899aabbccddeeff")
        )
    }

    func testAESKeyUnwrapRejectsInvalidIntegrityRegister() {
        XCTAssertThrowsError(
            try LegacyV1Envelope.aesKeyUnwrap(
                Data(hex: "64e8c3f9ce0f5ba263e9777905818a2a93c8191e7d6e8ae6"),
                key: Data(hex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
            )
        )
    }

    func testRecoversV1PossessionSecretAndValidatesItsExactWireShape() throws {
        let key = try ThunderboltCrypto.randomBytes(count: 32)
        let nonce = try ThunderboltCrypto.randomBytes(count: 12)
        let secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        let plaintext = Data("thunderbolt-canary-v1:\(secret)".utf8)
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce))
        let cipher = (box.ciphertext + box.tag).base64EncodedString()

        XCTAssertEqual(
            try LegacyV1Envelope.recoverPossessionSecret(contentKey: key, iv: nonce.base64EncodedString(), ciphertext: cipher),
            secret
        )
        XCTAssertFalse(LegacyV1Envelope.opensSample("__enc:\(nonce.base64EncodedString()):\(cipher)", contentKey: Data(repeating: 1, count: 32)))
        XCTAssertTrue(LegacyV1Envelope.opensSample("__enc:\(nonce.base64EncodedString()):\(cipher)", contentKey: key))
    }

    func testPossessionRecoveryRejectsWrongKeyAndMalformedLegacyPayload() throws {
        let key = try ThunderboltCrypto.randomBytes(count: 32)
        let nonce = try ThunderboltCrypto.randomBytes(count: 12)
        let box = try AES.GCM.seal(Data("not a canary".utf8), using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce))
        let cipher = (box.ciphertext + box.tag).base64EncodedString()

        XCTAssertThrowsError(
            try LegacyV1Envelope.recoverPossessionSecret(contentKey: Data(repeating: 4, count: 32), iv: nonce.base64EncodedString(), ciphertext: cipher)
        )
        XCTAssertThrowsError(
            try LegacyV1Envelope.recoverPossessionSecret(contentKey: key, iv: nonce.base64EncodedString(), ciphertext: cipher)
        )
    }
}

private extension Data {
    init(hex: String) {
        self.init(stride(from: 0, to: hex.count, by: 2).map { offset in
            let start = hex.index(hex.startIndex, offsetBy: offset)
            let end = hex.index(start, offsetBy: 2)
            return UInt8(hex[start..<end], radix: 16)!
        })
    }
}
