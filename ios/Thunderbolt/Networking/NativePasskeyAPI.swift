/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

private let passkeyPRFSalt = Data("thunderbolt-e2ee-passkey-prf-v1".utf8)
private let passkeyChallengeHeader = "X-Passkey-Challenge"

struct NativePasskeyRegistration: Sendable {
    let credentialID: String
    let prfOutput: Data?
}

struct NativePasskeyAssertion: Sendable {
    let credentialID: String
    let prfOutput: Data?
}

struct NativePasskeyRecord: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let credentialID: String
    let name: String?
    let createdAt: String?
    let deviceType: String?
    let backedUp: Bool?
}

enum NativePasskeyError: Error, LocalizedError {
    case unsupportedRelyingParty
    case prfUnavailable
    case invalidCredential
    case missingChallenge

    var errorDescription: String? {
        switch self {
        case .unsupportedRelyingParty:
            nativeString( "Passkeys are not configured for this app's domain.")
        case .prfUnavailable:
            nativeString( "This passkey provider cannot unlock encrypted sync.")
        case .invalidCredential:
            nativeString( "The passkey response could not be verified.")
        case .missingChallenge:
            nativeString( "The server did not return a passkey challenge.")
        }
    }
}

/// Passkey ceremonies for the native app. PRF output is returned separately from WebAuthn
/// response JSON and is only intended to derive the same in-memory keypair as other clients.
@MainActor
final class NativePasskeyAPI {
    nonisolated static let relyingPartyID = "app.thunderbolt.io"

    private let client: CloudClient
    private let ceremony = NativePasskeyCeremony()

    init(client: CloudClient) { self.client = client }

    func register(token: String, userID: String, userName: String) async throws -> NativePasskeyRegistration {
        let (options, challenge) = try await fetchOptions(
            path: "api/auth/passkey/generate-register-options",
            token: token,
            as: PasskeyRegistrationOptions.self
        )
        guard options.rp.id == Self.relyingPartyID else { throw NativePasskeyError.unsupportedRelyingParty }
        let result = try await ceremony.register(
            options: options,
            userIDFallback: Data(userID.utf8),
            userNameFallback: userName,
            prfSalt: passkeyPRFSalt
        )
        try await verify(
            path: "api/auth/passkey/verify-registration",
            token: token,
            challenge: challenge,
            body: PasskeyRegistrationVerification(response: result.response, name: userName)
        )
        return NativePasskeyRegistration(credentialID: result.credentialID, prfOutput: result.prfOutput)
    }

    func authenticate() async throws -> CloudSession {
        let (options, challenge) = try await fetchOptions(
            path: "api/auth/passkey/generate-authenticate-options",
            token: nil,
            as: PasskeyAssertionOptions.self
        )
        guard options.rpID == Self.relyingPartyID else { throw NativePasskeyError.unsupportedRelyingParty }
        let assertion = try await ceremony.assertion(options: options, prfSalt: nil)
        let body = try JSONEncoder().encode(PasskeyAssertionVerification(response: assertion.response))
        let response = try await send(
            path: "api/auth/passkey/verify-authentication",
            method: "POST",
            token: nil,
            challenge: challenge,
            body: body
        )
        guard let token = response.http.value(forHTTPHeaderField: "set-auth-token"), !token.isEmpty,
              let root = try JSONSerialization.jsonObject(with: response.data) as? [String: Any],
              let userJSON = root["user"],
              JSONSerialization.isValidJSONObject(userJSON),
              let user = try? JSONDecoder().decode(CloudUser.self, from: JSONSerialization.data(withJSONObject: userJSON)) else {
            throw CloudError.missingToken
        }
        return CloudSession(token: token, user: user)
    }

    /// Run an assertion with the protocol's fixed salt; this is local and never calls the server.
    func unlockPRF(credentialID: String) async throws -> Data {
        let credential = try PasskeyWire.decodeBase64URL(credentialID)
        let output = try await ceremony.localPRF(
            credentialID: credential,
            relyingPartyID: Self.relyingPartyID,
            salt: passkeyPRFSalt
        )
        guard output.count == 32 else { throw NativePasskeyError.prfUnavailable }
        return output
    }

    func list(token: String) async throws -> [NativePasskeyRecord] {
        try await requestJSON(path: "api/auth/passkey/list-user-passkeys", token: token, method: "GET")
    }

    /// Call only after the encryption passkey slot has been removed by an AK rotation.
    func delete(recordID: String, token: String) async throws {
        struct Body: Encodable { let id: String }
        let body = try JSONEncoder().encode(Body(id: recordID))
        _ = try await send(path: "api/auth/passkey/delete-passkey", method: "POST", token: token, body: body)
    }

    private func fetchOptions<Response: Decodable>(path: String, token: String?, as type: Response.Type) async throws -> (Response, String) {
        let response = try await send(path: path, method: "GET", token: token)
        guard let challenge = response.http.value(forHTTPHeaderField: passkeyChallengeHeader), !challenge.isEmpty else {
            throw NativePasskeyError.missingChallenge
        }
        return (try JSONDecoder().decode(type, from: response.data), challenge)
    }

    private func verify<Body: Encodable>(path: String, token: String, challenge: String, body: Body) async throws {
        let encoded = try JSONEncoder().encode(body)
        _ = try await send(path: path, method: "POST", token: token, challenge: challenge, body: encoded)
    }

    private func requestJSON<Response: Decodable>(path: String, token: String, method: String) async throws -> Response {
        let response = try await send(path: path, method: method, token: token)
        return try JSONDecoder().decode(Response.self, from: response.data)
    }

    private func send(path: String, method: String, token: String?, challenge: String? = nil, body: Data? = nil) async throws -> (data: Data, http: HTTPURLResponse) {
        var request = try client.makeRequest(path: path, method: method, token: token)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let challenge { request.setValue(challenge, forHTTPHeaderField: passkeyChallengeHeader) }
        return try await client.perform(request)
    }
}

private struct PasskeyRegistrationOptions: Decodable {
    struct RelyingParty: Decodable { let id: String? }
    struct User: Decodable { let id: String; let name: String?; let displayName: String? }
    struct Credential: Decodable { let id: String }

    let challenge: String
    let rp: RelyingParty
    let user: User
    let excludeCredentials: [Credential]?
}

private struct PasskeyAssertionOptions: Decodable {
    struct Credential: Decodable { let id: String }

    let challenge: String
    let rpID: String?
    let allowCredentials: [Credential]?

    enum CodingKeys: String, CodingKey {
        case challenge
        case rpID = "rpId"
        case allowCredentials
    }
}

private struct RegistrationResponseJSON: Encodable {
    struct Response: Encodable {
        let clientDataJSON: String
        let attestationObject: String
        let transports: [String] = []
    }

    let id: String
    let rawId: String
    let type = "public-key"
    let response: Response
    let clientExtensionResults: [String: String] = [:]
}

private struct AssertionResponseJSON: Encodable {
    struct Response: Encodable {
        let clientDataJSON: String
        let authenticatorData: String
        let signature: String
        let userHandle: String?
    }

    let id: String
    let rawId: String
    let type = "public-key"
    let response: Response
    let clientExtensionResults: [String: String] = [:]
}

private struct PasskeyRegistrationVerification: Encodable {
    let response: RegistrationResponseJSON
    let name: String?
}

private struct PasskeyAssertionVerification: Encodable {
    let response: AssertionResponseJSON
}

private struct PasskeyRegistrationResult {
    let credentialID: String
    let response: RegistrationResponseJSON
    let prfOutput: Data?
}

private struct PasskeyAssertionResult {
    let credentialID: String
    let response: AssertionResponseJSON
    let prfOutput: Data?
}

@MainActor
private final class NativePasskeyCeremony: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    func register(options: PasskeyRegistrationOptions, userIDFallback: Data, userNameFallback: String, prfSalt: Data) async throws -> PasskeyRegistrationResult {
        guard let rpID = options.rp.id, rpID == NativePasskeyAPI.relyingPartyID else {
            throw NativePasskeyError.unsupportedRelyingParty
        }
        let challenge = try PasskeyWire.decodeBase64URL(options.challenge)
        let userID = try PasskeyWire.decodeBase64URL(options.user.id)
        let userName = options.user.name ?? options.user.displayName ?? userNameFallback
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpID)
        let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: userName, userID: userID.isEmpty ? userIDFallback : userID)
        request.userVerificationPreference = .required
        request.displayName = userNameFallback
        request.excludedCredentials = (options.excludeCredentials ?? []).compactMap { try? PasskeyWire.decodeBase64URL($0.id) }.map {
            ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
        }
        guard #available(iOS 18.0, *) else { throw NativePasskeyError.prfUnavailable }
        request.prf = .inputValues(ASAuthorizationPublicKeyCredentialPRFRegistrationInput.InputValues(saltInput1: prfSalt))
        let authorization = try await perform(request)
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
              let attestation = credential.rawAttestationObject else { throw NativePasskeyError.invalidCredential }
        return PasskeyRegistrationResult(
            credentialID: PasskeyWire.encodeBase64URL(credential.credentialID),
            response: RegistrationResponseJSON(
                id: PasskeyWire.encodeBase64URL(credential.credentialID),
                rawId: PasskeyWire.encodeBase64URL(credential.credentialID),
                response: .init(
                    clientDataJSON: PasskeyWire.encodeBase64URL(credential.rawClientDataJSON),
                    attestationObject: PasskeyWire.encodeBase64URL(attestation)
                )
            ),
            prfOutput: credential.prf.flatMap { output in output.first?.withUnsafeBytes { Data($0) } }
        )
    }

    func assertion(options: PasskeyAssertionOptions, prfSalt: Data?) async throws -> PasskeyAssertionResult {
        guard let rpID = options.rpID, rpID == NativePasskeyAPI.relyingPartyID else {
            throw NativePasskeyError.unsupportedRelyingParty
        }
        let descriptors = try (options.allowCredentials ?? []).map {
            ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: try PasskeyWire.decodeBase64URL($0.id))
        }
        return try await assertion(challenge: PasskeyWire.decodeBase64URL(options.challenge), rpID: rpID, allowCredentials: descriptors, prfSalt: prfSalt)
    }

    func localPRF(credentialID: Data, relyingPartyID: String, salt: Data) async throws -> Data {
        let descriptor = ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: credentialID)
        let result = try await assertion(challenge: ThunderboltCrypto.randomBytes(count: 32), rpID: relyingPartyID, allowCredentials: [descriptor], prfSalt: salt)
        guard let output = result.prfOutput else { throw NativePasskeyError.prfUnavailable }
        return output
    }

    private func assertion(challenge: Data, rpID: String, allowCredentials: [ASAuthorizationPlatformPublicKeyCredentialDescriptor], prfSalt: Data?) async throws -> PasskeyAssertionResult {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpID)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        request.allowedCredentials = allowCredentials
        request.userVerificationPreference = .required
        if let prfSalt {
            guard #available(iOS 18.0, *) else { throw NativePasskeyError.prfUnavailable }
            request.prf = .inputValues(ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: prfSalt))
        }
        let authorization = try await perform(request)
        guard let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw NativePasskeyError.invalidCredential
        }
        let id = PasskeyWire.encodeBase64URL(assertion.credentialID)
        return PasskeyAssertionResult(
            credentialID: id,
            response: AssertionResponseJSON(
                id: id,
                rawId: id,
                response: .init(
                    clientDataJSON: PasskeyWire.encodeBase64URL(assertion.rawClientDataJSON),
                    authenticatorData: PasskeyWire.encodeBase64URL(assertion.rawAuthenticatorData),
                    signature: PasskeyWire.encodeBase64URL(assertion.signature),
                    userHandle: assertion.userID.isEmpty ? nil : PasskeyWire.encodeBase64URL(assertion.userID)
                )
            ),
            prfOutput: assertion.prf.map { output in output.first.withUnsafeBytes { Data($0) } }
        )
    }

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            DispatchQueue.main.async { controller.performRequests() }
        }
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        continuation?.resume(returning: authorization)
        continuation = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}

enum PasskeyWire {
    static func decodeBase64URL(_ string: String) throws -> Data {
        let standard = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let padded = standard + String(repeating: "=", count: (4 - standard.count % 4) % 4)
        guard let data = Data(base64Encoded: padded) else { throw NativePasskeyError.invalidCredential }
        return data
    }

    static func encodeBase64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
