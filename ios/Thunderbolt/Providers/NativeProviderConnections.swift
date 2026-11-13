/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import CryptoKit
import Foundation
import Observation

enum NativeProviderType: String, CaseIterable, Hashable, Identifiable, Sendable {
    case openAI = "openai"
    case anthropic
    case custom
    case openRouter = "openrouter"
    case tinfoil
    case otari
    case exa
    case brave
    case tavily

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .openAI: "OpenAI"
        case .anthropic: "Anthropic"
        case .custom: "OpenAI-compatible"
        case .openRouter: "OpenRouter"
        case .tinfoil: "Tinfoil"
        case .otari: "Otari"
        case .exa: "Exa"
        case .brave: "Brave"
        case .tavily: "Tavily"
        }
    }

    var requiresURL: Bool { self == .custom || self == .otari }
    var defaultURL: String? {
        switch self {
        case .otari: "https://api.otari.ai/api/v1"
        default: nil
        }
    }
}

enum NativeProviderAuthMethod: String, Sendable {
    case apiKey = "api_key"
    case oauth
}

struct NativeProviderConnection: Identifiable, Equatable, Sendable {
    let id: String
    let provider: NativeProviderType
    let name: String
    let url: String?
    let authMethod: NativeProviderAuthMethod
    let enabled: Bool
    let connected: Bool
    let updatedAt: String?
}

enum NativeProviderConnectionError: Error, Equatable {
    case invalidName
    case invalidURL
    case missingAPIKey
    case unsupportedAuthentication
    case connectionChanged
    case authorizationExpired
    case authorizationFailed
    case credentialUnavailable
    case revokeFailed
}

/// Reads and mutates shared connection metadata plus device-local credentials.
/// API keys and OAuth grants never enter PowerSync's synchronized tables.
actor NativeProviderConnectionRepository {
    private let store: NativeSyncStore
    private let ownerID: String
    private let now: @Sendable () -> Date

    init(store: NativeSyncStore, ownerID: String, now: @escaping @Sendable () -> Date = Date.init) {
        self.store = store
        self.ownerID = ownerID
        self.now = now
    }

    func load() async throws -> [NativeProviderConnection] {
        async let metadataRows = store.readAll(table: "provider_connections")
        async let secretRows = store.readAll(table: "provider_connection_secrets")
        let (metadata, secrets) = try await (metadataRows, secretRows)
        let secretByID = Dictionary(uniqueKeysWithValues: secrets.map { ($0.id, $0) })
        return metadata.compactMap { row in
            guard let providerText = Self.text(row, "provider"),
                  let provider = NativeProviderType(rawValue: providerText),
                  let name = Self.text(row, "name"), !name.isEmpty,
                  let authText = Self.text(row, "auth_method"),
                  let auth = NativeProviderAuthMethod(rawValue: authText) else { return nil }
            let url = Self.text(row, "url")
            let secret = secretByID[row.id]
            let bound = Self.text(secret, "binding") == Self.binding(provider: provider, auth: auth, url: url)
            let credentials = Self.credentials(Self.text(secret, "credentials"))
            let expiry = (credentials["expires_at"] as? NSNumber)?.doubleValue ?? .infinity
            let connected = bound && credentials["reauth_required"] as? Bool != true &&
                Self.hasUsableCredential(credentials, auth: auth) && expiry > now().timeIntervalSince1970 * 1000 + 60_000
            return NativeProviderConnection(
                id: row.id,
                provider: provider,
                name: name,
                url: url,
                authMethod: auth,
                enabled: Self.integer(row, "enabled") == 1,
                connected: connected,
                updatedAt: Self.text(row, "updated_at")
            )
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func saveAPIKey(provider: NativeProviderType, name: String, url rawURL: String?, apiKey: String) async throws -> String {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw NativeProviderConnectionError.invalidName }
        let url = try Self.normalizedURL(provider, rawURL)
        if provider != .custom && apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw NativeProviderConnectionError.missingAPIKey
        }
        let id = UUID().uuidString.lowercased()
        let credentials = ["apiKey": apiKey, "sessionRevision": UUID().uuidString] as [String: Any]
        try await save(provider: provider, id: id, name: name, url: url, auth: .apiKey, credentials: credentials)
        return id
    }

    func saveTinfoilOAuth(_ tokens: NativeTinfoilOAuthTokens, authorizationID: String) async throws {
        try await saveTinfoilOAuth(tokens, authorizationID: authorizationID, expectedRevision: nil)
    }

    func saveTinfoilOAuth(
        _ tokens: NativeTinfoilOAuthTokens,
        authorizationID: String,
        expectedRevision: String?
    ) async throws {
        if let expectedRevision, try await tinfoilRevision() != expectedRevision { throw NativeProviderConnectionError.connectionChanged }
        let id = "oauth:tinfoil"
        let existing = try await store.read(table: "provider_connections", id: id)
        if let existing,
           Self.text(existing, "provider") != NativeProviderType.tinfoil.rawValue || Self.text(existing, "auth_method") != NativeProviderAuthMethod.oauth.rawValue {
            throw NativeProviderConnectionError.connectionChanged
        }
        let oldSecret = try await store.read(table: "provider_connection_secrets", id: id)
        let previous = Self.credentials(Self.text(oldSecret, "credentials"))
        let incomingAccess = tokens.accessToken
        var revisionAfterRevocation = expectedRevision
        if let previousAccess = previous["access_token"] as? String,
           previousAccess != incomingAccess,
           let revokeToken = previous["refresh_token"] as? String ?? Optional(previousAccess) {
            try await NativeTinfoilOAuthRevoker.revoke(token: revokeToken)
            if let expectedRevision, try await tinfoilRevision() != expectedRevision {
                throw NativeProviderConnectionError.connectionChanged
            }
            var retired = previous
            retired["reauth_required"] = true
            retired["sessionRevision"] = UUID().uuidString
            let credentialsJSON = try Self.json(retired)
            if let oldSecret, let currentCredentials = Self.text(oldSecret, "credentials"),
               let binding = Self.text(oldSecret, "binding") {
                try await store.compareAndWriteLocal(
                    table: "provider_connection_secrets", id: id,
                    expected: ["credentials": .text(currentCredentials), "binding": .text(binding)],
                    values: ["credentials": .text(credentialsJSON), "binding": .text(binding)]
                )
            } else {
                try await store.write(table: "provider_connection_secrets", id: id, values: [
                    "credentials": .text(credentialsJSON), "binding": Self.text(oldSecret, "binding").map(NativeSyncValue.text) ?? .null,
                ])
            }
            revisionAfterRevocation = try await tinfoilRevision()
        }
        let credentials: [String: Any] = [
            "access_token": tokens.accessToken,
            "refresh_token": tokens.refreshToken as Any? ?? NSNull(),
            "expires_at": (now().timeIntervalSince1970 + tokens.expiresIn) * 1000,
            "authorizationId": authorizationID,
            "sessionRevision": UUID().uuidString,
        ]
        try await save(
            provider: .tinfoil,
            id: id,
            name: "Tinfoil",
            url: nil,
            auth: .oauth,
            credentials: credentials,
            enabled: Self.integer(existing, "enabled") != 0,
            expectedRevision: revisionAfterRevocation
        )
    }

    func setEnabled(id: String, enabled: Bool) async throws {
        guard let row = try await store.read(table: "provider_connections", id: id) else {
            throw NativeProviderConnectionError.connectionChanged
        }
        var mutations = [NativeSyncMutation(table: "provider_connections", id: id, values: [
            "enabled": .integer(enabled ? 1 : 0), "updated_at": .text(nextTimestamp(Self.text(row, "updated_at"))),
        ])]
        if let secret = try await store.read(table: "provider_connection_secrets", id: id) {
            var credentials = Self.credentials(Self.text(secret, "credentials"))
            credentials["sessionRevision"] = UUID().uuidString
            mutations.append(NativeSyncMutation(table: "provider_connection_secrets", id: id, values: [
                "credentials": .text(try Self.json(credentials)),
            ]))
        }
        try await store.writeTransaction(mutations)
    }

    func tinfoilRevision() async throws -> String {
        let connection = try await store.read(table: "provider_connections", id: "oauth:tinfoil")
        let secret = try await store.read(table: "provider_connection_secrets", id: "oauth:tinfoil")
        let legacy = try await store.read(table: "integrations_secrets", id: "tinfoil")
        let credentials = Self.credentials(Self.text(secret, "credentials"))
        let legacyCredentials = Self.credentials(Self.text(legacy, "credentials"))
        let state: [Any] = [
            Self.optional(Self.text(connection, "provider")),
            Self.optional(Self.text(connection, "name")),
            Self.optional(Self.text(connection, "url")),
            Self.optional(Self.text(connection, "auth_method")),
            Self.optional(Self.integer(connection, "enabled")),
            Self.optional(Self.text(connection, "deleted_at")),
            Self.optional(Self.text(connection, "updated_at")),
            Self.optional(credentials["sessionRevision"] as? String),
            Self.optional(Self.integer(legacy, "enabled")),
            legacyCredentials["sessionRevision"] ?? legacyCredentials,
        ]
        let data = try JSONSerialization.data(withJSONObject: state, options: [.fragmentsAllowed, .sortedKeys])
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func disconnect(id: String) async throws {
        let secret = try await store.read(table: "provider_connection_secrets", id: id)
        let current = Self.credentials(Self.text(secret, "credentials"))
        let currentRaw = Self.text(secret, "credentials")
        let currentBinding = Self.text(secret, "binding")
        var revokedTinfoil = false
        if id == "oauth:tinfoil",
           let access = current["access_token"] as? String,
           let token = current["refresh_token"] as? String ?? Optional(access) {
            try await NativeTinfoilOAuthRevoker.revoke(token: token)
            revokedTinfoil = true
        }
        let values: [String: NativeSyncValue] = [
            "credentials": .text(Self.sessionRevisionOnly()), "binding": .null,
        ]
        if revokedTinfoil, let currentRaw, let currentBinding {
            try await store.compareAndWriteLocal(
                table: "provider_connection_secrets", id: id,
                expected: ["credentials": .text(currentRaw), "binding": .text(currentBinding)],
                values: values
            )
        } else {
            try await store.write(table: "provider_connection_secrets", id: id, values: values)
        }
    }

    func remove(id: String) async throws {
        try await disconnect(id: id)
        guard let row = try await store.read(table: "provider_connections", id: id) else {
            throw NativeProviderConnectionError.connectionChanged
        }
        try await store.writeTransaction([
            NativeSyncMutation(table: "provider_connections", id: id, values: [
                "enabled": .integer(0),
                "deleted_at": .text(Self.formatTimestamp(now())),
                "updated_at": .text(nextTimestamp(Self.text(row, "updated_at"))),
            ]),
        ])
    }

    private func save(
        provider: NativeProviderType,
        id: String,
        name: String,
        url: String?,
        auth: NativeProviderAuthMethod,
        credentials: [String: Any],
        enabled: Bool? = nil,
        expectedRevision: String? = nil
    ) async throws {
        if let expectedRevision, try await tinfoilRevision() != expectedRevision {
            throw NativeProviderConnectionError.connectionChanged
        }
        let existing = try await store.read(table: "provider_connections", id: id)
        if let existing,
           Self.text(existing, "provider") != provider.rawValue || Self.text(existing, "auth_method") != auth.rawValue {
            throw NativeProviderConnectionError.connectionChanged
        }
        let stamp = nextTimestamp(Self.text(existing, "updated_at"))
        let values: [String: NativeSyncValue] = [
            "provider": .text(provider.rawValue), "name": .text(name), "url": url.map(NativeSyncValue.text) ?? .null,
            "auth_method": .text(auth.rawValue),
            "enabled": .integer((enabled ?? (Self.integer(existing, "enabled").map { $0 != 0 } ?? true)) ? 1 : 0),
            "created_at": Self.text(existing, "created_at").map(NativeSyncValue.text) ?? .text(stamp),
            "updated_at": .text(stamp), "deleted_at": .null, "user_id": .text(ownerID),
        ]
        try await store.writeTransaction([
            NativeSyncMutation(table: "provider_connections", id: id, values: values),
            NativeSyncMutation(table: "provider_connection_secrets", id: id, values: [
                "credentials": .text(try Self.json(credentials)),
                "binding": .text(Self.binding(provider: provider, auth: auth, url: url)),
            ]),
        ])
    }

    private static func normalizedURL(_ provider: NativeProviderType, _ input: String?) throws -> String? {
        guard provider.requiresURL else { return nil }
        let raw = input?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? provider.defaultURL
        guard let raw, var components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil else {
            throw NativeProviderConnectionError.invalidURL
        }
        let normalizedHost = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let localHTTP = scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(normalizedHost)
        guard scheme == "https" || localHTTP else { throw NativeProviderConnectionError.invalidURL }
        if provider == .otari {
            guard components.path.isEmpty || components.path == "/" || components.path == "/api/v1" else {
                throw NativeProviderConnectionError.invalidURL
            }
            components.path = "/api/v1"
        }
        while components.path.hasSuffix("/") { components.path.removeLast() }
        guard let url = components.url else { throw NativeProviderConnectionError.invalidURL }
        return url.absoluteString
    }

    private static func binding(provider: NativeProviderType, auth: NativeProviderAuthMethod, url: String?) -> String {
        let value: [Any] = [provider.rawValue, auth.rawValue, url as Any? ?? NSNull()]
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        return String(decoding: data, as: UTF8.self)
    }

    private static func hasUsableCredential(_ value: [String: Any], auth: NativeProviderAuthMethod) -> Bool {
        let key = auth == .oauth ? (value["access_token"] as? String) : (value["apiKey"] as? String)
        return key?.isEmpty == false
    }

    private static func credentials(_ value: String?) -> [String: Any] {
        guard let value, let data = value.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return parsed
    }

    private static func json(_ value: [String: Any]) throws -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
            throw NativeProviderConnectionError.credentialUnavailable
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static func sessionRevisionOnly() -> String { "{\"sessionRevision\":\"\(UUID().uuidString)\"}" }

    private func nextTimestamp(_ previous: String?) -> String {
        let previousMillis = previous.flatMap(Self.parseTimestamp) ?? 0
        return Self.formatTimestamp(Date(timeIntervalSince1970: max(now().timeIntervalSince1970, previousMillis + 0.001)))
    }

    private static func parseTimestamp(_ value: String) -> TimeInterval? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)?.timeIntervalSince1970 ?? ISO8601DateFormatter().date(from: value)?.timeIntervalSince1970
    }

    private static func formatTimestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func text(_ row: NativeSyncRow?, _ key: String) -> String? {
        guard case .text(let value)? = row?.values[key] else { return nil }
        return value
    }

    private static func integer(_ row: NativeSyncRow?, _ key: String) -> Int64? {
        guard case .integer(let value)? = row?.values[key] else { return nil }
        return value
    }

    private static func optional<T>(_ value: T?) -> Any { value.map { $0 as Any } ?? NSNull() }
}

@MainActor
@Observable
final class NativeProviderConnectionLibrary {
    private(set) var connections: [NativeProviderConnection] = []
    private(set) var error: String?
    private(set) var isWorking = false

    @ObservationIgnored private let repository: NativeProviderConnectionRepository
    @ObservationIgnored private let tinfoilOAuth: NativeTinfoilOAuthEnrollment

    init(store: NativeSyncStore, server: String, userID: String, vault: DeviceVault = DeviceVault(service: "net.thunderbird.thunderbolt.native.tinfoil.oauth")) {
        repository = NativeProviderConnectionRepository(store: store, ownerID: userID)
        tinfoilOAuth = NativeTinfoilOAuthEnrollment(repository: repository, server: server, userID: userID, vault: vault)
    }

    func reload() async {
        do { connections = try await repository.load(); error = nil }
        catch { self.error = error.localizedDescription }
    }

    func saveAPIKey(provider: NativeProviderType, name: String, url: String?, apiKey: String) async {
        await perform { _ = try await repository.saveAPIKey(provider: provider, name: name, url: url, apiKey: apiKey) }
    }

    func beginTinfoilOAuth() async {
        await perform { try await tinfoilOAuth.begin() }
    }

    /// The app's `.onOpenURL` forwards every URL here. Non-Tinfoil links return false.
    func handleTinfoilCallback(_ url: URL) async -> Bool {
        do {
            let handled = try await tinfoilOAuth.handleCallback(url)
            if handled { connections = try await repository.load(); error = nil }
            return handled
        } catch {
            self.error = error.localizedDescription
            return true
        }
    }

    func setEnabled(_ connection: NativeProviderConnection, enabled: Bool) async {
        await perform { try await repository.setEnabled(id: connection.id, enabled: enabled) }
    }

    func disconnect(_ connection: NativeProviderConnection) async {
        await perform { try await repository.disconnect(id: connection.id) }
    }

    func remove(_ connection: NativeProviderConnection) async {
        await perform { try await repository.remove(id: connection.id) }
    }

    func cancelTinfoilOAuth() { tinfoilOAuth.cancel() }

    private func perform(_ operation: () async throws -> Void) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do { try await operation(); connections = try await repository.load(); error = nil }
        catch { self.error = error.localizedDescription }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
