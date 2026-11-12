/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import XCTest
@testable import Thunderbolt

final class LegacyV1UpgradeAPITests: XCTestCase {
    func testRequestCarriesOnlyMigratingDeviceAndReadOnlyV1KeySlot() throws {
        let accountKey = Data(repeating: 0x31, count: 32)
        let legacyContentKey = Data(repeating: 0x72, count: 32)
        let dataKey = Data(repeating: 0x44, count: 32)
        let bootstrapRequest = DeviceBootstrapRequest(
            wrappedCK: "hybrid-envelope",
            attestation: "device-attestation",
            canaryIv: "canary-iv",
            canaryCtext: "canary-ciphertext",
            signingPublicKey: "signing-key",
            kdfSalt: "recovery-salt",
            wrappedKeys: [DeviceWrappedKey(keyId: "0", wrappedKey: try ThunderboltCrypto.wrapDEK(dataKey, accountKey: accountKey, keyID: "0"))],
            recoveryEcdhPublicKey: "recovery-ecdh",
            recoveryMlkemPublicKey: "recovery-mlkem",
            recoveryWrappedAK: "recovery-envelope",
            recoveryAttestation: "recovery-attestation"
        )
        let bootstrap = FirstDeviceBootstrap(
            request: bootstrapRequest, accountKey: accountKey, initialDataKey: dataKey,
            recoveryPhrase: "phrase", keys: try ThunderboltCrypto.generateDeviceKeys()
        )

        let request = try LegacyV1UpgradeRequest.make(
            nonce: "one-time-upgrade-nonce", possessionProof: String(repeating: "a", count: 64),
            deviceID: "trusted-device", bootstrap: bootstrap, legacyContentKey: legacyContentKey
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        let envelopes = try XCTUnwrap(json["envelopes"] as? [[String: Any]])
        let keys = try XCTUnwrap(json["wrappedKeys"] as? [[String: Any]])

        XCTAssertEqual(json["nonce"] as? String, "one-time-upgrade-nonce")
        XCTAssertEqual(json["possessionProof"] as? String, String(repeating: "a", count: 64))
        XCTAssertEqual(envelopes.count, 1)
        XCTAssertEqual(envelopes[0]["deviceId"] as? String, "trusted-device")
        XCTAssertEqual(envelopes[0]["wrappedCK"] as? String, "hybrid-envelope")
        XCTAssertEqual(keys.compactMap { $0["keyId"] as? String }.sorted(), ["0", "v1"])
        XCTAssertEqual(keys.count, 2)

        let wrappedLegacyKey = try XCTUnwrap(keys.first { $0["keyId"] as? String == "v1" }?["wrappedKey"] as? String)
        XCTAssertEqual(try ThunderboltCrypto.unwrapDEK(wrappedLegacyKey, accountKey: accountKey, keyID: "v1"), legacyContentKey)
        XCTAssertNil(json["proof"])
        XCTAssertNil(json["devices"])
    }

    func testRequestRejectsInvalidProofOrNonBootstrapWrappedKeyList() throws {
        let bootstrap = FirstDeviceBootstrap(
            request: DeviceBootstrapRequest(
                wrappedCK: "envelope", attestation: "attestation", canaryIv: "iv", canaryCtext: "ciphertext",
                signingPublicKey: "signing", kdfSalt: "salt", wrappedKeys: [],
                recoveryEcdhPublicKey: "ecdh", recoveryMlkemPublicKey: "mlkem",
                recoveryWrappedAK: "recovery", recoveryAttestation: "signature"
            ),
            accountKey: Data(repeating: 1, count: 32), initialDataKey: Data(repeating: 2, count: 32),
            recoveryPhrase: "phrase", keys: try ThunderboltCrypto.generateDeviceKeys()
        )
        XCTAssertThrowsError(try LegacyV1UpgradeRequest.make(
            nonce: "nonce", possessionProof: "invalid", deviceID: "device", bootstrap: bootstrap,
            legacyContentKey: Data(repeating: 3, count: 32)
        ))
        XCTAssertThrowsError(try LegacyV1UpgradeRequest.make(
            nonce: "nonce", possessionProof: String(repeating: "b", count: 64), deviceID: "device",
            bootstrap: bootstrap, legacyContentKey: Data(repeating: 3, count: 32)
        ))
    }
}
