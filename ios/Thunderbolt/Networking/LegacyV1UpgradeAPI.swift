/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

struct LegacyV1UpgradeEnvelope: Encodable, Sendable, Equatable {
    let deviceId: String
    let wrappedCK: String
    let attestation: String
}

/// Exact POST `/encryption/upgrade` contract for a trusted v1 migrator.
/// Construct only after the legacy CK has opened the old canary and, when a local
/// legacy row exists, has passed the ciphertext continuity check.
struct LegacyV1UpgradeRequest: Encodable, Sendable, Equatable {
    let nonce: String
    let possessionProof: String
    let envelopes: [LegacyV1UpgradeEnvelope]
    let wrappedKeys: [DeviceWrappedKey]
    let primaryKeyId: String
    let canaryIv: String
    let canaryCtext: String
    let signingPublicKey: String
    let kdfSalt: String
    let recoveryEcdhPublicKey: String
    let recoveryMlkemPublicKey: String
    let recoveryWrappedAK: String
    let recoveryAttestation: String
    let orgEnvelope: String?

    static func make(
        nonce: String,
        possessionProof: String,
        deviceID: String,
        bootstrap: FirstDeviceBootstrap,
        legacyContentKey: Data
    ) throws -> LegacyV1UpgradeRequest {
        guard !nonce.isEmpty, !deviceID.isEmpty,
              possessionProof.count == 64,
              possessionProof.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              legacyContentKey.count == 32,
              bootstrap.accountKey.count == 32,
              bootstrap.initialDataKey.count == 32,
              bootstrap.request.wrappedKeys.count == 1,
              bootstrap.request.wrappedKeys[0].keyId == "0" else {
            throw CryptoFailure.malformedValue
        }
        let wrappedLegacyKey = try ThunderboltCrypto.wrapDEK(
            legacyContentKey,
            accountKey: bootstrap.accountKey,
            keyID: "v1"
        )
        return LegacyV1UpgradeRequest(
            nonce: nonce,
            possessionProof: possessionProof,
            envelopes: [LegacyV1UpgradeEnvelope(
                deviceId: deviceID,
                wrappedCK: bootstrap.request.wrappedCK,
                attestation: bootstrap.request.attestation
            )],
            wrappedKeys: bootstrap.request.wrappedKeys + [DeviceWrappedKey(keyId: "v1", wrappedKey: wrappedLegacyKey)],
            primaryKeyId: "0",
            canaryIv: bootstrap.request.canaryIv,
            canaryCtext: bootstrap.request.canaryCtext,
            signingPublicKey: bootstrap.request.signingPublicKey,
            kdfSalt: bootstrap.request.kdfSalt,
            recoveryEcdhPublicKey: bootstrap.request.recoveryEcdhPublicKey,
            recoveryMlkemPublicKey: bootstrap.request.recoveryMlkemPublicKey,
            recoveryWrappedAK: bootstrap.request.recoveryWrappedAK,
            recoveryAttestation: bootstrap.request.recoveryAttestation,
            orgEnvelope: bootstrap.request.orgEnvelope
        )
    }
}

struct LegacyV1UpgradeResponse: Decodable, Sendable, Equatable {
    let keyVersion: Int
    let schemeVersion: Int

    enum CodingKeys: String, CodingKey {
        case keyVersion = "key_version"
        case schemeVersion = "scheme_version"
    }
}

@MainActor
extension CloudClient {
    func upgradeLegacyV1(_ requestBody: LegacyV1UpgradeRequest, token: String) async throws -> LegacyV1UpgradeResponse {
        var request = try makeRequest(path: "encryption/upgrade", method: "POST", token: token)
        request.httpBody = try JSONEncoder().encode(requestBody)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let response = try await perform(request)
        return try JSONDecoder().decode(LegacyV1UpgradeResponse.self, from: response.data)
    }
}
