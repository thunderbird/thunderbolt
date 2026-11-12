/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import CryptoKit
import Foundation

private struct NativeMCPProtectedResource: Decodable {
    let authorizationServers: [String]
    let scopesSupported: [String]?
    enum CodingKeys: String, CodingKey {
        case authorizationServers = "authorization_servers"
        case scopesSupported = "scopes_supported"
    }
}

private struct NativeMCPAuthorizationMetadata: Decodable {
    let issuer: String
    let authorizationEndpoint: String
    let tokenEndpoint: String
    let registrationEndpoint: String?
    let codeChallengeMethodsSupported: [String]?
    let authorizationResponseIssuerParameterSupported: Bool?
    enum CodingKeys: String, CodingKey {
        case issuer
        case authorizationEndpoint = "authorization_endpoint"
        case tokenEndpoint = "token_endpoint"
        case registrationEndpoint = "registration_endpoint"
        case codeChallengeMethodsSupported = "code_challenge_methods_supported"
        case authorizationResponseIssuerParameterSupported = "authorization_response_iss_parameter_supported"
    }
}

private struct NativeMCPOAuthHandshake: Codable {
    let serverID: String
    let serverURL: String
    let accountServer: String
    let userID: String
    let redirectURL: String
    let issuer: String
    let authorizationEndpoint: String
    let tokenEndpoint: String
    let clientID: String
    let state: String
    let scope: String?
    let requiresIssuer: Bool
    let startedAt: Date
}

/// OAuth 2.1 discovery, DCR, PKCE, universal-link callback and refresh for MCP servers.
@MainActor
@Observable
final class NativeMCPOAuthCoordinator {
    static let callbackURL = URL(string: "https://app.thunderbolt.io/mcp/oauth/callback")!
    private(set) var pendingServerID: String?
    private(set) var error: String?
    @ObservationIgnored private let repository: NativeMCPRepository
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let vault: DeviceVault
    @ObservationIgnored private let accountServer: String
    @ObservationIgnored private let userID: String
    @ObservationIgnored private let stateKey = "native.mcp.oauth.handshake"
    @ObservationIgnored private var refreshTasks: [String: Task<String, Error>] = [:]
    @ObservationIgnored private var generation = 0

    init(repository: NativeMCPRepository, accountServer: String, userID: String, defaults: UserDefaults = .standard,
         session: URLSession? = nil, vault: DeviceVault = DeviceVault(service: "net.thunderbird.thunderbolt.native.mcp.oauth")) {
        self.repository = repository
        self.accountServer = accountServer
        self.userID = userID
        self.defaults = defaults
        self.vault = vault
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        self.session = session ?? URLSession(configuration: configuration, delegate: NativeMCPNoRedirectDelegate(), delegateQueue: nil)
        pendingServerID = loadHandshake()?.serverID
    }

    func begin(server: NativeMCPServer) async throws -> URL {
        let requestGeneration = generation
        guard server.type != .iroh, let resourceURL = URL(string: server.url) else { throw NativeMCPError.invalidURL }
        try NativeMCPClient.validate(resourceURL)
        if let current = loadHandshake(), current.serverID != server.id,
           Date().timeIntervalSince(current.startedAt) < 600 {
            throw NativeMCPOAuthError.flowInProgress
        }
        if case .some = loadHandshake() { clearPending() }
        let resource = try await discoverResourceMetadata(resourceURL)
        try ensureCurrent(requestGeneration)
        guard let issuer = resource.authorizationServers.first, let issuerURL = URL(string: issuer) else {
            throw NativeMCPOAuthError.notSupported
        }
        try NativeMCPClient.validate(issuerURL)
        let metadata = try await discoverAuthorizationMetadata(issuerURL)
        try ensureCurrent(requestGeneration)
        guard metadata.issuer == issuer,
              metadata.codeChallengeMethodsSupported?.contains("S256") == true,
              let registrationEndpoint = metadata.registrationEndpoint,
              let registrationURL = URL(string: registrationEndpoint) else {
            throw NativeMCPOAuthError.notSupported
        }
        try NativeMCPClient.validate(registrationURL)
        let registration = try await postJSON([
            "client_name": "Thunderbolt",
            "redirect_uris": [Self.callbackURL.absoluteString],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        ], to: registrationURL)
        try ensureCurrent(requestGeneration)
        guard let clientID = registration["client_id"] as? String, !clientID.isEmpty else {
            throw NativeMCPError.invalidResponse
        }

        let verifier = Self.randomURLSafe(bytes: 32)
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        let state = Self.randomURLSafe(bytes: 32)
        let scope = resource.scopesSupported?.joined(separator: " ")
        guard let authURL = URL(string: metadata.authorizationEndpoint) else { throw NativeMCPError.invalidURL }
        try NativeMCPClient.validate(authURL)
        var components = URLComponents(url: authURL, resolvingAgainstBaseURL: false)
        var query = components?.queryItems ?? []
        query += [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: Self.callbackURL.absoluteString),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "resource", value: resourceURL.absoluteString),
        ]
        if let scope, !scope.isEmpty { query.append(URLQueryItem(name: "scope", value: scope)) }
        components?.queryItems = query
        guard let url = components?.url else { throw NativeMCPError.invalidURL }
        try ensureCurrent(requestGeneration)
        try vault.save(verifier, server: accountServer, userID: userID)
        saveHandshake(NativeMCPOAuthHandshake(
            serverID: server.id, serverURL: resourceURL.absoluteString, accountServer: accountServer, userID: userID,
            redirectURL: Self.callbackURL.absoluteString, issuer: metadata.issuer,
            authorizationEndpoint: metadata.authorizationEndpoint, tokenEndpoint: metadata.tokenEndpoint,
            clientID: clientID, state: state, scope: scope,
            requiresIssuer: metadata.authorizationResponseIssuerParameterSupported == true, startedAt: Date()
        ))
        pendingServerID = server.id
        error = nil
        return url
    }

    /// Claims only the pinned HTTPS callback URI and consumes state before exchange.
    func handleCallback(_ url: URL) async -> Bool {
        guard url.scheme == "https", url.host == "app.thunderbolt.io", url.path == "/mcp/oauth/callback" else { return false }
        let requestGeneration = generation
        guard let handshake = loadHandshake() else {
            error = nativeString("No MCP authorization is waiting for a callback.")
            return true
        }
        clearHandshake()
        let vaultServer = handshake.accountServer
        let vaultUserID = handshake.userID
        let verifier = try? vault.load(String.self, server: vaultServer, userID: vaultUserID)
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value: (String) -> String? = { key in query.first(where: { $0.name == key })?.value }
        guard handshake.accountServer == accountServer, handshake.userID == userID else {
            try? vault.remove(server: vaultServer, userID: vaultUserID)
            error = NativeMCPOAuthError.serverChanged.localizedDescription
            return true
        }
        guard value("state") == handshake.state else {
            try? vault.remove(server: vaultServer, userID: vaultUserID)
            error = nativeString("MCP authorization state did not match; authorization was rejected.")
            return true
        }
        if let returnedIssuer = value("iss"), returnedIssuer != handshake.issuer {
            try? vault.remove(server: vaultServer, userID: vaultUserID)
            error = nativeString("MCP authorization issuer did not match; authorization was rejected.")
            return true
        }
        if handshake.requiresIssuer && value("iss") == nil {
            try? vault.remove(server: vaultServer, userID: vaultUserID)
            error = nativeString("The authorization server omitted its required issuer.")
            return true
        }
        guard let code = value("code"), !code.isEmpty else {
            try? vault.remove(server: vaultServer, userID: vaultUserID)
            error = value("error_description") ?? value("error") ?? nativeString("MCP authorization was not completed.")
            return true
        }
        do {
            guard let verifier else { throw NativeMCPOAuthError.reauthorize }
            guard let server = try await repository.load().first(where: { $0.id == handshake.serverID && $0.url == handshake.serverURL }) else {
                throw NativeMCPOAuthError.serverChanged
            }
            let token = try await exchange(url: URL(string: handshake.tokenEndpoint)!, fields: [
                "grant_type": "authorization_code", "client_id": handshake.clientID,
                "code": code, "redirect_uri": handshake.redirectURL, "code_verifier": verifier,
                "resource": handshake.serverURL,
            ])
            try ensureCurrent(requestGeneration)
            guard let accessToken = token["access_token"] as? String else { throw NativeMCPError.invalidResponse }
            let credential = NativeMCPStoredCredentials.oauth(
                accessToken: accessToken, refreshToken: token["refresh_token"] as? String,
                expiresAt: (token["expires_in"] as? Double).map { Date().timeIntervalSince1970 * 1000 + $0 * 1000 },
                clientID: handshake.clientID, issuer: handshake.issuer, tokenEndpoint: handshake.tokenEndpoint,
                scope: token["scope"] as? String ?? handshake.scope
            )
            try await repository.setCredentials(credential, for: server.id, expectedURL: server.url)
            try? vault.remove(server: vaultServer, userID: vaultUserID)
            pendingServerID = nil
            error = nil
        } catch {
            try? vault.remove(server: vaultServer, userID: vaultUserID)
            self.error = error.localizedDescription
        }
        return true
    }

    func accessToken(for serverID: String) async throws -> String? {
        let requestGeneration = generation
        guard let credential = try await repository.credentials(for: serverID) else { return nil }
        guard case .oauth(let accessToken, let refreshToken, let expiresAt, let clientID, let issuer, let tokenEndpoint, let scope) = credential else {
            return credential.bearerToken
        }
        guard let expiresAt, expiresAt <= Date().timeIntervalSince1970 * 1000 + 60_000 else { return accessToken }
        guard let refreshToken, let clientID, let issuer, let tokenEndpoint else { throw NativeMCPOAuthError.reauthorize }
        if let task = refreshTasks[serverID] { return try await task.value }
        let task = Task { try await self.refresh(serverID: serverID, refreshToken: refreshToken, clientID: clientID,
            issuer: issuer, tokenEndpoint: tokenEndpoint, scope: scope, previous: credential,
            generation: requestGeneration) }
        refreshTasks[serverID] = task
        defer { refreshTasks[serverID] = nil }
        return try await task.value
    }

    private func refresh(
        serverID: String, refreshToken: String, clientID: String, issuer: String, tokenEndpoint: String,
        scope: String?, previous: NativeMCPStoredCredentials, generation requestGeneration: Int
    ) async throws -> String {
        guard let resource = try await repository.serverURL(for: serverID) else { throw NativeMCPOAuthError.serverChanged }
        let token = try await exchange(url: URL(string: tokenEndpoint)!, fields: [
            "grant_type": "refresh_token", "client_id": clientID,
            "refresh_token": refreshToken, "resource": resource,
        ])
        try ensureCurrent(requestGeneration)
        guard let updatedAccessToken = token["access_token"] as? String else { throw NativeMCPError.invalidResponse }
        let updated = NativeMCPStoredCredentials.oauth(
            accessToken: updatedAccessToken, refreshToken: token["refresh_token"] as? String ?? refreshToken,
            expiresAt: (token["expires_in"] as? Double).map { Date().timeIntervalSince1970 * 1000 + $0 * 1000 },
            clientID: clientID, issuer: issuer, tokenEndpoint: tokenEndpoint, scope: token["scope"] as? String ?? scope
        )
        try await repository.replaceCredentials(updated, for: serverID, expected: previous)
        return updatedAccessToken
    }

    func clearPending() {
        generation &+= 1
        if let handshake = loadHandshake() {
            try? vault.remove(server: handshake.accountServer, userID: handshake.userID)
        }
        clearHandshake()
        error = nil
    }

    private func discoverResourceMetadata(_ resourceURL: URL) async throws -> NativeMCPProtectedResource {
        let path = resourceURL.path == "/" ? "" : resourceURL.path
        let pathAware = URL(string: "/.well-known/oauth-protected-resource\(path)", relativeTo: resourceURL)!
        if let object = try? await getJSON(pathAware),
           let data = try? JSONSerialization.data(withJSONObject: object),
           let metadata = try? JSONDecoder().decode(NativeMCPProtectedResource.self, from: data) { return metadata }
        let fallback = URL(string: "/.well-known/oauth-protected-resource", relativeTo: resourceURL)!
        let object = try await getJSON(fallback)
        return try JSONDecoder().decode(NativeMCPProtectedResource.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func discoverAuthorizationMetadata(_ issuer: URL) async throws -> NativeMCPAuthorizationMetadata {
        let path = issuer.path == "/" ? "" : issuer.path
        let candidates = [
            URL(string: "/.well-known/oauth-authorization-server\(path)", relativeTo: issuer)!,
            URL(string: "/.well-known/openid-configuration\(path)", relativeTo: issuer)!,
            URL(string: "\(path)/.well-known/openid-configuration", relativeTo: issuer)!,
        ]
        for candidate in candidates {
            guard let object = try? await getJSON(candidate),
                  let data = try? JSONSerialization.data(withJSONObject: object),
                  let metadata = try? JSONDecoder().decode(NativeMCPAuthorizationMetadata.self, from: data) else { continue }
            return metadata
        }
        throw NativeMCPOAuthError.notSupported
    }

    private func getJSON(_ url: URL) async throws -> [String: Any] {
        try NativeMCPClient.validate(url)
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("2025-03-26", forHTTPHeaderField: "MCP-Protocol-Version")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NativeMCPError.invalidResponse
        }
        return object
    }

    private func postJSON(_ object: [String: Any], to url: URL) async throws -> [String: Any] {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpBody = try JSONSerialization.data(withJSONObject: object)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NativeMCPError.invalidResponse
        }
        return result
    }

    private func exchange(url: URL, fields: [String: String]) async throws -> [String: Any] {
        try NativeMCPClient.validate(url)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        var components = URLComponents()
        components.queryItems = fields.map { URLQueryItem(name: $0.key, value: $0.value) }
        request.httpBody = components.percentEncodedQuery?.data(using: .utf8)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw NativeMCPError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let code = body?["error"] as? String
            if ["invalid_grant", "invalid_request", "invalid_client", "unauthorized_client"].contains(code) {
                throw NativeMCPOAuthError.reauthorize
            }
            throw NativeMCPError.http(http.statusCode, code ?? "OAuth token request failed")
        }
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeMCPError.invalidResponse }
        return value
    }

    private func loadHandshake() -> NativeMCPOAuthHandshake? {
        guard let data = defaults.data(forKey: stateKey) else { return nil }
        return try? JSONDecoder().decode(NativeMCPOAuthHandshake.self, from: data)
    }

    private func saveHandshake(_ handshake: NativeMCPOAuthHandshake) {
        defaults.set(try? JSONEncoder().encode(handshake), forKey: stateKey)
    }

    private func clearHandshake() {
        defaults.removeObject(forKey: stateKey)
        pendingServerID = nil
    }

    private func ensureCurrent(_ requestGeneration: Int) throws {
        try Task.checkCancellation()
        guard generation == requestGeneration else { throw CancellationError() }
    }

    private static func randomURLSafe(bytes: Int) -> String {
        base64URL(Data((0..<bytes).map { _ in UInt8.random(in: .min ... .max) }))
    }

    private static func base64URL(_ data: some DataProtocol) -> String {
        Data(data).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

enum NativeMCPOAuthError: Error, LocalizedError, Equatable {
    case flowInProgress
    case notSupported
    case serverChanged
    case reauthorize
    var errorDescription: String? {
        switch self {
        case .flowInProgress: nativeString("Another MCP authorization is already in progress.")
        case .notSupported: nativeString("This MCP server does not support the required OAuth 2.1 flow.")
        case .serverChanged: nativeString("The MCP server changed during authorization.")
        case .reauthorize: nativeString("Reconnect this MCP server to authorize again.")
        }
    }
}

private extension URL {
    var origin: URL { URL(string: "\(scheme ?? "https")://\(host ?? "")\(port.map { ":\($0)" } ?? "")")! }
}
