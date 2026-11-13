/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

struct ApprovalSessionRecord: Decodable, Sendable, Equatable {
    let sessionId: String
    let commitment: String?
    let reveal: String?
    let challenge: String?
    let challengerDeviceId: String?
    let expired: Bool
}

struct ApprovalSessionStart: Encodable, Sendable {
    let sessionId: String
    let commitment: String
}

struct ApprovalSessionReveal: Encodable, Sendable {
    let sessionId: String
    let reveal: String
}

struct ApprovalSessionChallenge: Encodable, Sendable {
    let sessionId: String
    let challenge: String
}

struct DeviceEnvelopeApprovalRequest: Encodable, Sendable {
    let deviceId: String
    let wrappedCK: String
    let attestation: String
    let proof: DeviceChallengeProof
}

struct RotationEnvelopeTarget: Decodable, Sendable {
    let deviceID: String
    let ecdhPublicKey: String
    let mlkemPublicKey: String
    let attestation: String?

    enum CodingKeys: String, CodingKey {
        case deviceID = "device_id"
        case ecdhPublicKey = "public_key"
        case mlkemPublicKey = "mlkem_public_key"
        case attestation
    }
}

struct RotationEnvelopeTargets: Decodable, Sendable {
    let devices: [RotationEnvelopeTarget]
}

struct LockoutPendingDevices: Decodable, Sendable {
    let deviceIDs: [String]
    enum CodingKeys: String, CodingKey { case deviceIDs = "device_ids" }
}

struct RotationKey: Codable, Sendable, Equatable {
    let keyId: String
    let wrappedKey: String
}

struct RotationDeviceEnvelope: Encodable, Sendable {
    let deviceId: String
    let wrappedCK: String
    let attestation: String
}

struct AccountKeyRotationRequest: Encodable, Sendable {
    let proof: DeviceChallengeProof
    let stepUpOtp: String?
    let envelopes: [RotationDeviceEnvelope]
    let wrappedKeys: [RotationKey]
    let newPrimaryKey: RotationKey?
    let canaryIv: String
    let canaryCtext: String
    let signingPublicKey: String
    let kdfSalt: String
    let recoveryEcdhPublicKey: String
    let recoveryMlkemPublicKey: String
    let recoveryWrappedAK: String
    let recoveryAttestation: String
    let passkeyCredentialId: String?
    let passkeyEcdhPublicKey: String?
    let passkeyMlkemPublicKey: String?
    let passkeyWrappedAK: String?
    let passkeyAttestation: String?
    let orgEnvelope: String?
}

struct AccountKeyRotationResponse: Decodable, Sendable {
    let keyVersion: Int
    enum CodingKeys: String, CodingKey { case keyVersion = "key_version" }
}

struct StepUpCodeRequestResponse: Decodable, Sendable { let ok: Bool }

@MainActor
extension CloudClient {
    func rotationEnvelopeTargets(token: String) async throws -> RotationEnvelopeTargets {
        try await accountJSON("encryption/envelope-targets", token: token)
    }

    func lockoutPendingDevices(token: String) async throws -> LockoutPendingDevices {
        try await accountJSON("encryption/lockout-pending", token: token)
    }

    func rotationWrappedKeys(token: String) async throws -> [DeviceWrappedKeyResponse] {
        struct Response: Decodable { let keys: [DeviceWrappedKeyResponse] }
        let response: Response = try await accountJSON("encryption/keys", token: token)
        return response.keys
    }

    func rotateAccountKey(_ body: AccountKeyRotationRequest, token: String) async throws -> AccountKeyRotationResponse {
        try await accountJSONWrite("encryption/rotate", token: token, body: body)
    }

    func requestRecoveryPhraseChangeCode(token: String) async throws {
        try await accountWriteWithoutBody("encryption/step-up/request", token: token)
    }

    func revokeAccountDevice(deviceID: String, proof: DeviceChallengeProof, token: String) async throws {
        try await accountWrite("account/devices/\(try Self.accountPathSegment(deviceID))/revoke", token: token, body: RevokeDeviceRequest(proof: proof))
    }

    func requestAccountDeletionCode(token: String) async throws {
        try await accountWriteWithoutBody("account/deletion/step-up/request", token: token)
    }

    func deleteAccount(stepUpOTP: String, token: String) async throws {
        var request = try makeRequest(path: "account", method: "DELETE", token: token)
        request.httpBody = try JSONEncoder().encode(AccountDeletionRequest(stepUpOtp: stepUpOTP))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await perform(request)
    }

    func startApprovalSession(_ body: ApprovalSessionStart, token: String) async throws {
        try await accountWrite("devices/me/approval-session", token: token, body: body)
    }

    func myApprovalSession(token: String) async throws -> ApprovalSessionRecord {
        try await accountJSON("devices/me/approval-session", token: token)
    }

    func revealApprovalSession(_ body: ApprovalSessionReveal, token: String) async throws {
        try await accountWrite("devices/me/approval-session/reveal", token: token, body: body)
    }

    func pendingApprovalSession(deviceID: String, token: String) async throws -> ApprovalSessionRecord {
        try await accountJSON("devices/\(try Self.accountPathSegment(deviceID))/approval-session", token: token)
    }

    func challengePendingApproval(deviceID: String, body: ApprovalSessionChallenge, token: String) async throws {
        try await accountWrite("devices/\(try Self.accountPathSegment(deviceID))/approval-session/challenge", token: token, body: body)
    }

    func storeApprovedEnvelope(_ body: DeviceEnvelopeApprovalRequest, token: String) async throws {
        try await accountWrite("devices/\(try Self.accountPathSegment(body.deviceId))/envelope", token: token, body: body)
    }

    func currentDeviceProof(operation: String, token: String) async throws -> DeviceChallenge {
        var request = try makeRequest(path: "encryption/challenge", method: "GET", token: token)
        guard let url = request.url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw CloudError.invalidServer
        }
        components.queryItems = [URLQueryItem(name: "operation", value: operation)]
        request.url = components.url
        return try JSONDecoder().decode(DeviceChallenge.self, from: try await perform(request).data)
    }

    private func accountJSON<Response: Decodable>(_ path: String, token: String) async throws -> Response {
        let request = try makeRequest(path: path, method: "GET", token: token)
        return try JSONDecoder().decode(Response.self, from: try await perform(request).data)
    }

    private func accountWrite<Body: Encodable>(_ path: String, token: String, body: Body) async throws {
        var request = try makeRequest(path: path, method: "POST", token: token)
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await perform(request)
    }

    private func accountJSONWrite<Response: Decodable, Body: Encodable>(_ path: String, token: String, body: Body) async throws -> Response {
        var request = try makeRequest(path: path, method: "POST", token: token)
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try JSONDecoder().decode(Response.self, from: try await perform(request).data)
    }

    private func accountWriteWithoutBody(_ path: String, token: String) async throws {
        let request = try makeRequest(path: path, method: "POST", token: token)
        _ = try await perform(request)
    }

    private static func accountPathSegment(_ value: String) throws -> String {
        guard !value.isEmpty, value != ".", value != "..",
              value.utf8.allSatisfy({
                  ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95
              }) else { throw CloudError.invalidResponse }
        return value
    }
}

private struct RevokeDeviceRequest: Encodable { let proof: DeviceChallengeProof }
private struct AccountDeletionRequest: Encodable { let stepUpOtp: String }
