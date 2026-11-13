/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import CryptoKit
import Foundation
import XCTest
@testable import Thunderbolt

private actor TestKeyProvider: E2EEKeyProviding {
    let configured: Bool
    let primary: String?
    let keys: [String: Data]

    init(configured: Bool, primary: String?, keys: [String: Data]) {
        self.configured = configured
        self.primary = primary
        self.keys = keys
    }

    func isEncryptionConfigured() async throws -> Bool { configured }
    func primaryKeyID() async throws -> String? { primary }
    func dataKey(for keyID: String) async throws -> Data? { keys[keyID] }
}

private struct E2EEInteropFixture: Decodable {
    struct Device: Decodable { let ecdhPrivateKeyRaw: String; let ecdhPublicKeyRaw: String; let mlkemPublicKey: String; let mlkemSecretKey: String }
    struct Envelope: Decodable { let accountKey: String; let primaryKeyID: String; let keyVersion: UInt32; let ephemeralECDHPrivateKeyRaw: String; let mlkemRandomness: String; let iv: String; let wrappedAK: String }
    struct DEK: Decodable { let accountKey: String; let dataKey: String; let keyID: String; let iv: String; let wrappedKey: String }
    let device: Device
    let envelope: Envelope
    let dek: DEK
}

final class CryptoInteropTests: XCTestCase {
    func testDecodesTypeScriptV2ColumnFixtureWithExactAAD() async throws {
        let key = Data(base64Encoded: "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=")!
        let codec = ThunderboltColumnCodec(keys: TestKeyProvider(configured: true, primary: "0", keys: ["0": key]))
        let wire = "__enc:v2:0:AAECAwQFBgcICQoL:JUMgLe5MU1vsUmSCvtXx+g2M+/ftbss1CKylZPTQtmjNO0cI2gd0Psi7LLD2bg=="

        let result = try await codec.decode(wire, context: E2EEContext(table: "chat_messages", column: "content", rowID: "msg_123"))

        XCTAssertEqual(result, "interoperability fixture café")
        let wrongRow = try await codec.decode(wire, context: E2EEContext(table: "chat_messages", column: "content", rowID: "other"))
        let missingContext = try await codec.decode(wire, context: nil)
        XCTAssertEqual(wrongRow, wire)
        XCTAssertEqual(missingContext, wire)
    }

    func testEncodeProducesV2AndRoundTripsUnderPrimaryDataKey() async throws {
        let key = try ThunderboltCrypto.randomBytes(count: 32)
        let codec = ThunderboltColumnCodec(keys: TestKeyProvider(configured: true, primary: "17", keys: ["17": key]))
        let context = E2EEContext(table: "chat_threads", column: "title", rowID: "thread-17")

        let wire = try await codec.encode("Private title", context: context)

        XCTAssertTrue(wire.hasPrefix("__enc:v2:17:"))
        let plaintext = try await codec.decode(wire, context: context)
        XCTAssertEqual(plaintext, "Private title")
    }

    func testCodecOnlyPassesPlaintextThroughForAccountsWithoutE2EESetup() async throws {
        let noSetup = ThunderboltColumnCodec(keys: TestKeyProvider(configured: false, primary: nil, keys: [:]))
        let clear = try await noSetup.encode("clear", context: E2EEContext(table: "settings", column: "value", rowID: "x"))
        XCTAssertEqual(clear, "clear")

        let incompleteSetup = ThunderboltColumnCodec(keys: TestKeyProvider(configured: true, primary: "0", keys: [:]))
        do {
            _ = try await incompleteSetup.encode("must not leak", context: E2EEContext(table: "settings", column: "value", rowID: "x"))
            XCTFail("Incomplete setup must refuse plaintext writes")
        } catch CryptoFailure.keyConfigurationIncomplete {}
    }

    func testUploadGuardRequiresAValidV2WireBlob() {
        let codec = ThunderboltColumnCodec(keys: TestKeyProvider(configured: false, primary: nil, keys: [:]))
        let valid = "__enc:v2:0:AAECAwQFBgcICQoL:JUMgLe5MU1vsUmSCvtXx+g2M+/ftbss1CKylZPTQtmjNO0cI2gd0Psi7LLD2bg=="
        XCTAssertTrue(codec.isEncryptedValue("__enc:not-a-valid-ciphertext"))
        XCTAssertTrue(codec.isValidV2Ciphertext(valid))
        XCTAssertFalse(codec.isValidV2Ciphertext("__enc:AAECAwQFBgcICQoL:AA=="))
        XCTAssertFalse(codec.isValidV2Ciphertext("__enc:v2:01:AAECAwQFBgcICQoL:AA=="))
        XCTAssertFalse(codec.isValidV2Ciphertext("__enc:v2:0:AAAA:AA=="))
        XCTAssertFalse(codec.isValidV2Ciphertext("__enc:v2:0:AAECAwQFBgcICQoL:AA=="))
    }

    func testWrappedDataKeyBindsItsKeyID() throws {
        let accountKey = try ThunderboltCrypto.randomBytes(count: 32)
        let dataKey = try ThunderboltCrypto.randomBytes(count: 32)
        let wrapped = try ThunderboltCrypto.wrapDEK(dataKey, accountKey: accountKey, keyID: "0")

        XCTAssertEqual(try ThunderboltCrypto.unwrapDEK(wrapped, accountKey: accountKey, keyID: "0"), dataKey)
        XCTAssertThrowsError(try ThunderboltCrypto.unwrapDEK(wrapped, accountKey: accountKey, keyID: "1"))
        XCTAssertThrowsError(try ThunderboltCrypto.unwrapDEK(wrapped, accountKey: accountKey, keyID: "01"))
        XCTAssertThrowsError(try ThunderboltCrypto.unwrapDEK(wrapped, accountKey: accountKey, keyID: "not-a-key-id"))
    }

    func testHybridEnvelopeAndWrappedDEKMatchTypeScriptVectorExactly() throws {
        let fixture = try loadInteropFixture()
        let device = ThunderboltDeviceKeys(
            ecdhPrivateKeyRaw: Data(base64Encoded: fixture.device.ecdhPrivateKeyRaw)!,
            mlkemSecretKey: Data(base64Encoded: fixture.device.mlkemSecretKey)!,
            mlkemPublicKey: Data(base64Encoded: fixture.device.mlkemPublicKey)!
        )
        XCTAssertEqual(try device.ecdhPublicKeyBase64, fixture.device.ecdhPublicKeyRaw)
        let entropy = HybridEnvelopeTestEntropy(
            ephemeralECDHPrivateKeyRaw: Data(base64Encoded: fixture.envelope.ephemeralECDHPrivateKeyRaw)!,
            mlkemRandomness: Data(base64Encoded: fixture.envelope.mlkemRandomness)!,
            iv: Data(base64Encoded: fixture.envelope.iv)!
        )
        let accountKey = Data(base64Encoded: fixture.envelope.accountKey)!
        let swiftEnvelope = try ThunderboltCrypto.wrapAK(
            accountKey,
            recipientEcdhPublicKey: Data(base64Encoded: fixture.device.ecdhPublicKeyRaw)!,
            recipientMLKEMPublicKey: Data(base64Encoded: fixture.device.mlkemPublicKey)!,
            primaryKeyID: fixture.envelope.primaryKeyID,
            keyVersion: fixture.envelope.keyVersion,
            entropy: entropy
        )

        XCTAssertEqual(swiftEnvelope, fixture.envelope.wrappedAK)
        let opened = try ThunderboltCrypto.unwrapAK(fixture.envelope.wrappedAK, deviceKeys: device)
        XCTAssertEqual(opened.rawKey, accountKey)
        XCTAssertEqual(opened.primaryKeyID, fixture.envelope.primaryKeyID)
        XCTAssertEqual(opened.keyVersion, fixture.envelope.keyVersion)

        let swiftWrappedDEK = try ThunderboltCrypto.wrapDEK(
            Data(base64Encoded: fixture.dek.dataKey)!,
            accountKey: Data(base64Encoded: fixture.dek.accountKey)!,
            keyID: fixture.dek.keyID,
            iv: Data(base64Encoded: fixture.dek.iv)!
        )
        XCTAssertEqual(swiftWrappedDEK, fixture.dek.wrappedKey)
        XCTAssertEqual(try ThunderboltCrypto.unwrapDEK(swiftWrappedDEK, accountKey: accountKey, keyID: fixture.dek.keyID), Data(base64Encoded: fixture.dek.dataKey)!)
    }

    func testHybridEnvelopeOpensOnlyForItsRecipientAndCarriesEpochPointer() throws {
        let deviceKeys = try ThunderboltCrypto.generateDeviceKeys()
        let accountKey = try ThunderboltCrypto.generateAccountKey()
        let envelope = try ThunderboltCrypto.wrapAK(accountKey, recipient: deviceKeys, primaryKeyID: "0", keyVersion: 3)

        let opened = try ThunderboltCrypto.unwrapAK(envelope, deviceKeys: deviceKeys)
        XCTAssertEqual(opened.rawKey, accountKey)
        XCTAssertEqual(opened.primaryKeyID, "0")
        XCTAssertEqual(opened.keyVersion, 3)

        let otherDevice = try ThunderboltCrypto.generateDeviceKeys()
        XCTAssertThrowsError(try ThunderboltCrypto.unwrapAK(envelope, deviceKeys: otherDevice))
    }

    func testRecoveryDerivationMatchesTypeScriptPublicKeyVector() throws {
        let phrase = "alpha deal scrub asthma idea logic bright thought alpha deal scrub asthma idea logic bright thought alpha deal scrub asthma idea logic bright truly"
        let salt = "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws="
        let keys = try ThunderboltCrypto.deriveRecoveryMaterial(phrase: phrase, kdfSalt: salt)
        let ecdhPublicKey = try keys.ecdhPublicKeyBase64
        let mlkemDigest = Data(SHA256.hash(data: keys.mlkemPublicKey)).base64EncodedString()

        XCTAssertEqual(ecdhPublicKey, "BGG/yJXQcSrhIepeuq6kqMikshr9JYY4hsiAawe6NYEim7IyOVFkgZAueV70FhzNhv0aVJ3WEtIwqDic6p6k8Q4=")
        XCTAssertEqual(mlkemDigest, "jJaTugRMfuabKcsMGwwgrA3DEHbQyCA3KGgp+gsCVak=")
    }

    func testApprovalCommitmentAndCodeMatchTypeScriptGoldenVector() throws {
        let anchor = DeviceApprovalAnchor(
            userID: "account-1",
            deviceID: "device-1",
            ecdhPublicKey: "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=",
            mlkemPublicKey: Data(repeating: 0, count: 1184).base64EncodedString()
        )
        let sessionID = "00112233445566778899aabbccddeeff"
        let challenge = String(repeating: "a", count: 64)
        let reveal = String(repeating: "b", count: 64)
        let context = try DeviceApprovalCrypto.createContext(anchor: anchor, sessionID: sessionID)
        let confirmation = DeviceApprovalConfirmation(
            sessionID: sessionID,
            commitment: try DeviceApprovalCrypto.commitment(context: context, reveal: reveal),
            challenge: challenge,
            reveal: reveal,
            code: try DeviceApprovalCrypto.code(context: context, challengerDeviceID: "trusted-device-1", challenge: challenge, reveal: reveal)
        )

        XCTAssertEqual(confirmation.commitment, "2fcddd2a1724489f2020f39136db55a032995ed041ff4892dbea56b271fed086")
        XCTAssertEqual(confirmation.code, "65")
        XCTAssertTrue(try DeviceApprovalCrypto.matches(confirmation, anchor: anchor, challengerDeviceID: "trusted-device-1"))
        XCTAssertFalse(try DeviceApprovalCrypto.matches(confirmation, anchor: anchor, challengerDeviceID: "other"))
    }

    func testAESKeyWrapMatchesRFC3394VectorUsedByOrganizationEscrow() throws {
        let wrappingKey = Data(hex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
        let accountKey = Data(hex: "00112233445566778899aabbccddeeff")
        XCTAssertEqual(try ThunderboltCrypto.aesKeyWrap(accountKey, key: wrappingKey), Data(hex: "64e8c3f9ce0f5ba263e9777905818a2a93c8191e7d6e8ae7"))
    }

    private func loadInteropFixture() throws -> E2EEInteropFixture {
        let bundle = Bundle(for: CryptoInteropTests.self)
        let url = bundle.url(forResource: "e2ee-vectors", withExtension: "json", subdirectory: "Fixtures")
            ?? bundle.url(forResource: "e2ee-vectors", withExtension: "json")
        return try JSONDecoder().decode(E2EEInteropFixture.self, from: Data(contentsOf: XCTUnwrap(url)))
    }
}

private extension Data {
    init(hex: String) {
        self.init(stride(from: 0, to: hex.count, by: 2).map { index in
            let start = hex.index(hex.startIndex, offsetBy: index)
            let end = hex.index(start, offsetBy: 2)
            return UInt8(hex[start..<end], radix: 16)!
        })
    }
}
