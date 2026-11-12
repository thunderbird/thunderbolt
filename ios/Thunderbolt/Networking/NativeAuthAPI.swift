/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

struct NativeAuthConfiguration: Codable, Sendable, Equatable {
    let authMode: String?
    let authAllowAnonymous: Bool?
    let captchaProvider: String?
    let passkeyEnabled: Bool?
    let passkeyRpId: String?
    let minimalMode: Bool?
    let builtInAgentEnabled: Bool?
    let allowCustomAgents: Bool?
    let branding: Branding?

    struct Branding: Codable, Sendable, Equatable {
        let appName: String?
    }

    var usesSSO: Bool { authMode == "oidc" || authMode == "saml" }
    var supportsEmailOTP: Bool { authMode == "consumer" }
    var supportsPasskey: Bool {
        supportsEmailOTP && passkeyEnabled == true && passkeyRpId == NativePasskeyAPI.relyingPartyID
    }
    var supportsAnonymousSignIn: Bool { supportsEmailOTP && authAllowAnonymous == true }
    var supportsBuiltInAgent: Bool { builtInAgentEnabled == true }
    var appName: String { branding?.appName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Thunderbolt" }
}

/// Native authentication endpoints and browser-mediated SSO for the current server.
@MainActor
final class NativeAuthAPI {
    static let callbackScheme = "net.thunderbird.thunderbolt.native"
    static let callbackHost = "sso-callback"

    private let client: CloudClient
    private let webAuth: NativeWebAuthenticationSession

    init(client: CloudClient, webAuth: NativeWebAuthenticationSession = NativeWebAuthenticationSession()) {
        self.client = client
        self.webAuth = webAuth
    }

    func loadConfiguration() async throws -> NativeAuthConfiguration {
        let request = try client.makeRequest(path: "config", method: "GET")
        let response = try await client.perform(request)
        return try JSONDecoder().decode(NativeAuthConfiguration.self, from: response.data)
    }

    func signInWithPasskey() async throws -> CloudSession {
        let configuration = try await loadConfiguration()
        guard configuration.supportsPasskey else { throw CloudError.invalidServer }
        return try await NativePasskeyAPI(client: client).authenticate()
    }

    func signInAnonymously() async throws -> CloudSession {
        let configuration = try await loadConfiguration()
        guard configuration.supportsAnonymousSignIn else { throw CloudError.invalidServer }
        let captchaToken: String?
        switch configuration.captchaProvider {
        case "none": captchaToken = nil
        case "altcha": captchaToken = try await solveALTCHA()
        default: throw CloudError.invalidServer
        }

        var request = try client.makeRequest(path: "api/auth/sign-in/anonymous", method: "POST")
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let captchaToken { request.setValue(captchaToken, forHTTPHeaderField: "x-captcha-token") }
        let response = try await client.perform(request)
        guard let token = response.http.value(forHTTPHeaderField: "set-auth-token"), !token.isEmpty,
              let session = try await client.restoreSession(token: token) else {
            throw CloudError.missingToken
        }
        return session
    }

    private func solveALTCHA() async throws -> String {
        let request = try client.makeRequest(path: "captcha/challenge", method: "GET")
        let response = try await client.perform(request)
        let challenge = try JSONDecoder().decode(NativeALTCHAChallenge.self, from: response.data)
        guard challenge.algorithm == "SHA-256", challenge.maxnumber >= 0, challenge.maxnumber <= 10_000_000 else {
            throw CloudError.invalidResponse
        }
        let number = try await Task.detached(priority: .userInitiated) {
            try NativeALTCHA.solve(challenge)
        }.value
        try Task.checkCancellation()
        let solution = NativeALTCHASolution(
            algorithm: challenge.algorithm,
            challenge: challenge.challenge,
            number: number,
            salt: challenge.salt,
            signature: challenge.signature
        )
        return try JSONEncoder().encode(solution).base64EncodedString()
    }

    func signInWithSSO() async throws -> CloudSession {
        let configuration = try await loadConfiguration()
        guard configuration.usesSSO else { throw CloudError.invalidServer }

        let state = Self.randomBase64URL(byteCount: 32)
        let verifier = Self.randomBase64URL(byteCount: 32)
        let challenge = Self.sha256Base64URL(verifier)
        var request = try client.makeRequest(path: "api/auth/sso/native-initiate", method: "GET")
        var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "state", value: state), URLQueryItem(name: "code_challenge", value: challenge)]
        guard let url = components.url else { throw CloudError.invalidServer }
        request.url = url

        let callback = try await webAuth.authenticate(url: url, callbackScheme: Self.callbackScheme)
        guard let callbackComponents = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              callback.scheme == Self.callbackScheme,
              callback.host == Self.callbackHost,
              callback.path.isEmpty || callback.path == "/",
              callback.user == nil,
              callback.password == nil,
              callback.fragment == nil,
              callbackComponents.queryItems(named: "state") == [state] else {
            throw CloudError.invalidResponse
        }
        if let error = callbackComponents.queryItems(named: "error").first {
            throw NativeSSOError.provider(error)
        }
        guard let code = callbackComponents.queryItems(named: "code").first, !code.isEmpty,
              callbackComponents.queryItems(named: "error").isEmpty else {
            throw CloudError.invalidResponse
        }

        var exchange = try client.makeRequest(path: "api/auth/sso/native-token", method: "POST")
        exchange.httpBody = try JSONEncoder().encode(NativeSSOTokenRequest(code: code, state: state, codeVerifier: verifier))
        exchange.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let response = try await client.perform(exchange)
        let token = try JSONDecoder().decode(NativeSSOTokenResponse.self, from: response.data).token
        guard let session = try await client.restoreSession(token: token) else { throw CloudError.invalidResponse }
        return session
    }

    private static func randomBase64URL(byteCount: Int) -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<byteCount).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private static func sha256Base64URL(_ value: String) -> String {
        let digest = SHA256.hash(data: Data(value.utf8))
        return Data(digest).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

@MainActor
protocol NativeAuthServing: CloudServing {
    func loadAuthConfiguration() async throws -> NativeAuthConfiguration
    func signInWithSSO() async throws -> CloudSession
    func signInWithPasskey() async throws -> CloudSession
    func signInAnonymously() async throws -> CloudSession
}

extension CloudClient: NativeAuthServing {
    func loadAuthConfiguration() async throws -> NativeAuthConfiguration {
        try await NativeAuthAPI(client: self).loadConfiguration()
    }

    func signInWithSSO() async throws -> CloudSession {
        try await NativeAuthAPI(client: self).signInWithSSO()
    }

    func signInWithPasskey() async throws -> CloudSession {
        try await NativeAuthAPI(client: self).signInWithPasskey()
    }

    func signInAnonymously() async throws -> CloudSession {
        try await NativeAuthAPI(client: self).signInAnonymously()
    }
}

struct NativeALTCHAChallenge: Decodable, Sendable {
    let algorithm: String
    let challenge: String
    let maxnumber: Int
    let salt: String
    let signature: String
}

private struct NativeALTCHASolution: Encodable {
    let algorithm: String
    let challenge: String
    let number: Int
    let salt: String
    let signature: String
}

enum NativeALTCHA {
    static func solve(_ challenge: NativeALTCHAChallenge) throws -> Int {
        for number in 0...challenge.maxnumber {
            if Task.isCancelled { throw CancellationError() }
            let digest = SHA256.hash(data: Data("\(challenge.salt)\(number)".utf8))
            let hex = digest.map { String(format: "%02x", $0) }.joined()
            if hex == challenge.challenge { return number }
        }
        throw CloudError.invalidResponse
    }
}

enum NativeSSOError: Error, LocalizedError, Equatable {
    case provider(String)

    var errorDescription: String? {
        switch self {
        case .provider(let code):
            switch code {
            case "access_denied": nativeString( "Sign-in was cancelled by your identity provider.")
            case "account_not_linked": nativeString( "This identity is not linked to an account. Contact your administrator.")
            default: nativeString( "The identity provider could not sign you in. Try again or contact your administrator.")
            }
        }
    }
}

private struct NativeSSOTokenRequest: Encodable {
    let code: String
    let state: String
    let codeVerifier: String
    enum CodingKeys: String, CodingKey { case code, state; case codeVerifier = "code_verifier" }
}

private struct NativeSSOTokenResponse: Decodable { let token: String }

@MainActor
final class NativeWebAuthenticationSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var activeSession: ASWebAuthenticationSession?

    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] callback, error in
                self?.activeSession = nil
                if let error { continuation.resume(throwing: error); return }
                guard let callback else { continuation.resume(throwing: CloudError.invalidResponse); return }
                continuation.resume(returning: callback)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            activeSession = session
            guard session.start() else {
                activeSession = nil
                continuation.resume(throwing: CloudError.invalidResponse)
                return
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

private extension URLComponents {
    func queryItems(named name: String) -> [String] {
        (queryItems ?? []).filter { $0.name == name }.compactMap(\.value)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
