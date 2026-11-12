/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import CryptoKit
import Foundation
import Security
import UIKit

private struct NativeTinfoilPendingAuthorization: Codable {
    let state: String
    let verifier: String
    let connectionRevision: String
    let createdAt: Date
}

/// Native equivalent of Tauri's mobile PKCE handoff. The verifier remains in this
/// device's Keychain; the universal-link callback carries only the code and state.
@MainActor
final class NativeTinfoilOAuthEnrollment {
    static let callback = URL(string: "https://app.thunderbolt.io/oauth/callback")!
    private static let lifetime: TimeInterval = 10 * 60

    private let repository: NativeProviderConnectionRepository
    private let server: String
    private let userID: String
    private let vault: DeviceVault

    init(repository: NativeProviderConnectionRepository, server: String, userID: String, vault: DeviceVault) {
        self.repository = repository
        self.server = server
        self.userID = userID
        self.vault = vault
    }

    func begin() async throws {
        let verifier = try Self.randomBase64URL(byteCount: 32)
        let state = try Self.randomBase64URL(byteCount: 32)
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        let revision = try await repository.tinfoilRevision()
        let flow = NativeTinfoilPendingAuthorization(
            state: state,
            verifier: verifier,
            connectionRevision: revision,
            createdAt: Date()
        )
        try vault.save(flow, server: server, userID: userID)

        var components = URLComponents(string: "https://dash.tinfoil.sh/oauth/authorize")!
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: NativeTinfoilOAuthRefresher.clientID),
            URLQueryItem(name: "redirect_uri", value: Self.callback.absoluteString),
            URLQueryItem(name: "scope", value: "inference:api offline_access"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        guard let authorizationURL = components.url,
              await UIApplication.shared.open(authorizationURL) else {
            try vault.remove(server: server, userID: userID)
            throw NativeProviderConnectionError.authorizationFailed
        }
    }

    /// Returns false for unrelated URLs. Matching callback URLs are consumed once.
    func handleCallback(_ url: URL) async throws -> Bool {
        guard url.scheme == "https", url.host?.lowercased() == Self.callback.host,
              url.path == Self.callback.path else { return false }
        guard url.user == nil, url.password == nil, url.fragment == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw NativeProviderConnectionError.authorizationFailed
        }
        let states = components.queryItems(named: "state")
        let codes = components.queryItems(named: "code")
        guard states.count == 1, codes.count == 1, components.queryItems(named: "error").isEmpty,
              let flow = try vault.load(NativeTinfoilPendingAuthorization.self, server: server, userID: userID),
              states[0] == flow.state,
              Date().timeIntervalSince(flow.createdAt) >= 0,
              Date().timeIntervalSince(flow.createdAt) <= Self.lifetime,
              !codes[0].isEmpty else {
            try vault.remove(server: server, userID: userID)
            throw NativeProviderConnectionError.authorizationFailed
        }

        // Clear before the bounded token exchange so a duplicate universal link
        // cannot reuse the one-time authorization code.
        try vault.remove(server: server, userID: userID)
        let tokens = try await Self.exchange(code: codes[0], verifier: flow.verifier)
        do {
            try await repository.saveTinfoilOAuth(
                tokens,
                authorizationID: UUID().uuidString,
                expectedRevision: flow.connectionRevision
            )
        } catch {
            try? await NativeTinfoilOAuthRevoker.revoke(token: tokens.refreshToken ?? tokens.accessToken)
            throw error
        }
        return true
    }

    func cancel() {
        try? vault.remove(server: server, userID: userID)
    }

    private static func exchange(code: String, verifier: String) async throws -> NativeTinfoilOAuthTokens {
        var request = URLRequest(url: URL(string: "https://api.tinfoil.sh/oauth/token")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.httpShouldHandleCookies = false
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "grant_type", value: "authorization_code"),
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "code_verifier", value: verifier),
            URLQueryItem(name: "redirect_uri", value: callback.absoluteString),
            URLQueryItem(name: "client_id", value: NativeTinfoilOAuthRefresher.clientID),
        ]
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        let (data, response) = try await NativeOAuthURLSession.make().data(for: request)
        guard let response = response as? HTTPURLResponse,
              (200..<300).contains(response.statusCode),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accessToken = body["access_token"] as? String, !accessToken.isEmpty,
              let expiry = (body["expires_in"] as? NSNumber)?.doubleValue, expiry.isFinite, expiry > 0,
              (body["token_type"] as? String)?.lowercased() == "bearer",
              (body["refresh_token"] as? String).map({ !$0.isEmpty }) ?? true else {
            throw NativeProviderConnectionError.authorizationFailed
        }
        return NativeTinfoilOAuthTokens(
            accessToken: accessToken,
            refreshToken: body["refresh_token"] as? String,
            expiresIn: expiry
        )
    }

    private static func randomBase64URL(byteCount: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw NativeProviderConnectionError.authorizationFailed
        }
        return base64URL(Data(bytes))
    }

    private static func base64URL<D: DataProtocol>(_ data: D) -> String {
        Data(data).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private extension URLComponents {
    func queryItems(named name: String) -> [String] {
        (queryItems ?? []).filter { $0.name == name }.compactMap(\.value)
    }
}

enum NativeTinfoilOAuthRevoker {
    static func revoke(token: String) async throws {
        var request = URLRequest(url: URL(string: "https://api.tinfoil.sh/oauth/revoke")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.httpShouldHandleCookies = false
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "client_id", value: NativeTinfoilOAuthRefresher.clientID),
            URLQueryItem(name: "token", value: token),
        ]
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        let (_, response) = try await NativeOAuthURLSession.make().data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw NativeProviderConnectionError.revokeFailed
        }
    }
}

enum NativeOAuthURLSession {
    static func make() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        return URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) { completionHandler(nil) }
}
