/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

struct DeviceRegistrationRequest: Encodable, Sendable {
    let deviceId: String
    let publicKey: String
    let mlkemPublicKey: String
    let name: String
}

struct DeviceRegistration: Decodable, Sendable {
    let trusted: Bool
    let envelope: String?
    let pendingSince: String?
}

struct DeviceEnvelopeResponse: Decodable, Sendable {
    let trusted: Bool
    let wrappedCK: String
    let attestation: String?
}

struct DeviceEncryptionMetadata: Decodable, Sendable {
    let canaryIv: String?
    let canaryCtext: String?
    let kdfSalt: String?
    let signingPublicKey: String?
    let recoveryEcdhPublicKey: String?
    let recoveryMlkemPublicKey: String?
    let recoveryWrappedAK: String?
    let recoveryAttestation: String?
    let passkeyCredentialID: String?
    let passkeyEcdhPublicKey: String?
    let passkeyMlkemPublicKey: String?
    let passkeyWrappedAK: String?
    let passkeyAttestation: String?
    let keyVersion: Int
    let primaryKeyID: String
    let schemeVersion: Int

    enum CodingKeys: String, CodingKey {
        case canaryIv = "canary_iv", canaryCtext = "canary_ctext", kdfSalt = "kdf_salt"
        case signingPublicKey = "signing_public_key"
        case recoveryEcdhPublicKey = "recovery_ecdh_public_key"
        case recoveryMlkemPublicKey = "recovery_mlkem_public_key"
        case recoveryWrappedAK = "recovery_wrapped_ak", recoveryAttestation = "recovery_attestation"
        case passkeyCredentialID = "passkey_credential_id"
        case passkeyEcdhPublicKey = "passkey_ecdh_public_key"
        case passkeyMlkemPublicKey = "passkey_mlkem_public_key"
        case passkeyWrappedAK = "passkey_wrapped_ak", passkeyAttestation = "passkey_attestation"
        case keyVersion = "key_version", primaryKeyID = "primary_key_id", schemeVersion = "scheme_version"
    }
}

struct DeviceWrappedKey: Codable, Sendable, Equatable {
    let keyId: String
    let wrappedKey: String
}

struct DeviceWrappedKeyResponse: Decodable, Sendable {
    let keyID: String
    let wrappedKey: String
    enum CodingKeys: String, CodingKey { case keyID = "key_id", wrappedKey = "wrapped_key" }
}

struct DeviceBootstrapRequest: Codable, Sendable, Equatable {
    let wrappedCK: String
    let attestation: String
    let canaryIv: String
    let canaryCtext: String
    let signingPublicKey: String
    let kdfSalt: String
    let wrappedKeys: [DeviceWrappedKey]
    let recoveryEcdhPublicKey: String
    let recoveryMlkemPublicKey: String
    let recoveryWrappedAK: String
    let recoveryAttestation: String
    var orgEnvelope: String? = nil
}

struct DeviceChallengeProof: Encodable, Sendable {
    let signature: String
    let nonce: String
    let operation: String
    let deviceId: String
}

struct DeviceChallenge: Decodable, Sendable {
    let nonce: String
    let expiresAt: String
    enum CodingKeys: String, CodingKey { case nonce, expiresAt = "expires_at" }
}

struct DeviceSealedBindNonce: Decodable, Sendable {
    let ephemeralPublicKey: String
    let iv: String
    let ciphertext: String
    enum CodingKeys: String, CodingKey { case ephemeralPublicKey = "ephemeral_public_key", iv, ciphertext }
}

struct DeviceBindChallenge: Decodable, Sendable {
    let sealed: DeviceSealedBindNonce
    let expiresAt: String
    enum CodingKeys: String, CodingKey { case sealed, expiresAt = "expires_at" }
}

@MainActor
protocol DeviceServing {
    func registerDevice(_ registration: DeviceRegistrationRequest, token: String) async throws -> DeviceRegistration
    func bindChallenge(token: String) async throws -> DeviceBindChallenge
    func bindDevice(id: String, nonce: String, token: String) async throws
    func encryptionMetadata(token: String) async throws -> DeviceEncryptionMetadata?
    func wrappedKeys(token: String) async throws -> [DeviceWrappedKeyResponse]
    func deviceEnvelope(token: String) async throws -> DeviceEnvelopeResponse
    func bootstrapDevice(id: String, request: DeviceBootstrapRequest, token: String) async throws
    func cancelDeviceApproval(pendingSince: String?, token: String) async throws
}

extension CloudClient: DeviceServing {
    func registerDevice(_ registration: DeviceRegistrationRequest, token: String) async throws -> DeviceRegistration {
        try await deviceJSON("devices", token: token, body: registration)
    }

    func bindChallenge(token: String) async throws -> DeviceBindChallenge {
        try await deviceJSON("devices/me/bind-challenge", token: token)
    }

    func bindDevice(id: String, nonce: String, token: String) async throws {
        try await deviceWrite("devices/me/bind", token: token, body: ["deviceId": id, "nonce": nonce])
    }

    func encryptionMetadata(token: String) async throws -> DeviceEncryptionMetadata? {
        do { return try await deviceJSON("encryption/canary", token: token) }
        catch CloudError.http(404, _) { return nil }
    }

    func wrappedKeys(token: String) async throws -> [DeviceWrappedKeyResponse] {
        struct Response: Decodable { let keys: [DeviceWrappedKeyResponse] }
        let response: Response = try await deviceJSON("encryption/keys", token: token)
        return response.keys
    }

    func deviceEnvelope(token: String) async throws -> DeviceEnvelopeResponse {
        try await deviceJSON("devices/me/envelope", token: token)
    }

    func bootstrapDevice(id: String, request: DeviceBootstrapRequest, token: String) async throws {
        try await deviceWrite("devices/\(try Self.devicePathSegment(id))/envelope", token: token, body: request)
    }

    func cancelDeviceApproval(pendingSince: String?, token: String) async throws {
        struct Request: Encodable { let pendingSince: String? }
        try await deviceWrite("devices/me/cancel-pending", token: token, body: Request(pendingSince: pendingSince))
    }

    func deviceProof(operation: String, token: String) async throws -> DeviceChallenge {
        var request = try makeRequest(path: "encryption/challenge", method: "GET", token: token)
        guard let url = request.url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw CloudError.invalidServer
        }
        components.queryItems = [URLQueryItem(name: "operation", value: operation)]
        request.url = components.url
        return try JSONDecoder().decode(DeviceChallenge.self, from: await perform(request).data)
    }

    /// Path identifiers are encoded as one segment; never allow a device id to choose an endpoint.
    private static func devicePathSegment(_ id: String) throws -> String {
        guard !id.isEmpty, id != ".", id != "..",
              id.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_")).contains($0) }) else {
            throw CloudError.invalidResponse
        }
        return id
    }

    private func deviceJSON<Response: Decodable>(_ path: String, token: String) async throws -> Response {
        let request = try makeRequest(path: path, method: "GET", token: token)
        return try JSONDecoder().decode(Response.self, from: await perform(request).data)
    }

    private func deviceJSON<Response: Decodable, Body: Encodable>(_ path: String, token: String, body: Body) async throws -> Response {
        let response = try await perform(deviceRequest(path, token: token, body: body))
        return try JSONDecoder().decode(Response.self, from: response.data)
    }

    private func deviceWrite<Body: Encodable>(_ path: String, token: String, body: Body) async throws {
        _ = try await perform(deviceRequest(path, token: token, body: body))
    }

    private func deviceRequest<Body: Encodable>(_ path: String, token: String, body: Body) throws -> URLRequest {
        var request = try makeRequest(path: path, method: "POST", token: token)
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }
}
