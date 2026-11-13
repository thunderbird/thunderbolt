/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Foundation

protocol NativeTinfoilOAuthRefreshing: Sendable {
    func refresh(refreshToken: String) async throws -> NativeTinfoilOAuthTokens
}

struct NativeTinfoilOAuthTokens: Sendable, Equatable {
    let accessToken: String
    let refreshToken: String?
    let expiresIn: TimeInterval
}

struct NativeTinfoilOAuthRefresher: NativeTinfoilOAuthRefreshing {
    static let clientID = "oauthc_SDVdLmN2tIicRCMaqNGijBTNKZceSmEjwolKnycjrypWSCvN"
    private static let endpoint = URL(string: "https://api.tinfoil.sh/oauth/token")!
    private let session: URLSession
    private let redirectDelegate: NativeTinfoilNoRedirectDelegate?

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
            redirectDelegate = nil
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.urlCache = nil
            let delegate = NativeTinfoilNoRedirectDelegate()
            self.session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
            redirectDelegate = delegate
        }
    }

    func refresh(refreshToken: String) async throws -> NativeTinfoilOAuthTokens {
        var request = URLRequest(url: Self.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.httpShouldHandleCookies = false
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "grant_type", value: "refresh_token"),
            URLQueryItem(name: "refresh_token", value: refreshToken),
            URLQueryItem(name: "client_id", value: Self.clientID),
        ]
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)

        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw NativeTinfoilOAuthError.refreshFailed }
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 400,
               let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               body["error"] as? String == "invalid_grant" {
                throw NativeTinfoilOAuthError.reauthorizationRequired
            }
            throw NativeTinfoilOAuthError.refreshFailed
        }
        guard let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accessToken = body["access_token"] as? String, !accessToken.isEmpty,
              let expiresIn = (body["expires_in"] as? NSNumber)?.doubleValue,
              expiresIn.isFinite, expiresIn > 0,
              (body["token_type"] as? String)?.lowercased() == "bearer",
              (body["refresh_token"] as? String).map({ !$0.isEmpty }) ?? true else {
            throw NativeTinfoilOAuthError.refreshFailed
        }
        return NativeTinfoilOAuthTokens(
            accessToken: accessToken,
            refreshToken: body["refresh_token"] as? String,
            expiresIn: expiresIn
        )
    }
}

private final class NativeTinfoilNoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

enum NativeTinfoilOAuthError: Error, Equatable {
    case modelUnavailable
    case credentialUnavailable
    case reauthorizationRequired
    case connectionChanged
    case refreshFailed
}

/// Resolves rotating Tinfoil credentials from existing local-only credential tables.
/// The database actor serializes reads and writes; in-flight refreshes are shared per model.
actor NativeTinfoilOAuthSession {
    private enum CredentialLocation: Sendable {
        case providerConnection(id: String, binding: String)
        case integration(id: String, enabled: Int64)

    }

    private struct CredentialSnapshot: Sendable {
        let location: CredentialLocation
        let raw: String
        let accessToken: String
        let refreshToken: String?
        let expiresAt: Double
        let reauthorizationRequired: Bool
    }

    private let store: NativeSyncStore
    private let refresher: any NativeTinfoilOAuthRefreshing
    private let now: @Sendable () -> TimeInterval
    private var refreshTasks: [String: Task<String, Error>] = [:]

    init(
        store: NativeSyncStore,
        refresher: any NativeTinfoilOAuthRefreshing = NativeTinfoilOAuthRefresher(),
        now: @escaping @Sendable () -> TimeInterval = { Date().timeIntervalSince1970 }
    ) {
        self.store = store
        self.refresher = refresher
        self.now = now
    }

    /// Returns a current Tinfoil OAuth token, refreshing and persisting rotation when needed.
    func accessToken(modelID: String) async throws -> String {
        if let task = refreshTasks[modelID] { return try await task.value }
        let snapshot = try await credentialSnapshot(modelID: modelID)
        guard !snapshot.reauthorizationRequired else {
            throw NativeTinfoilOAuthError.reauthorizationRequired
        }
        guard snapshot.expiresAt > (now() + 60) * 1000 else {
            guard let refreshToken = snapshot.refreshToken, !refreshToken.isEmpty else {
                try await markReauthorizationRequired(snapshot)
                throw NativeTinfoilOAuthError.reauthorizationRequired
            }
            let task = Task { try await self.refreshAndPersist(snapshot, refreshToken: refreshToken) }
            refreshTasks[modelID] = task
            do {
                let token = try await task.value
                refreshTasks[modelID] = nil
                return token
            } catch {
                refreshTasks[modelID] = nil
                throw error
            }
        }
        return snapshot.accessToken
    }

    private func credentialSnapshot(modelID: String) async throws -> CredentialSnapshot {
        async let models = store.readAll(table: "models")
        async let connections = store.readAll(table: "provider_connections")
        async let connectionSecrets = store.readAll(table: "provider_connection_secrets")
        async let modelSecrets = store.readAll(table: "models_secrets")
        async let integrationSecrets = store.readAll(table: "integrations_secrets")
        let (modelRows, connectionRows, connectionSecretRows, modelSecretRows, integrationRows) = try await (
            models, connections, connectionSecrets, modelSecrets, integrationSecrets
        )
        guard let model = modelRows.first(where: {
            $0.id == modelID && $0.values["provider"] == .text("tinfoil") &&
                $0.values["is_system"] != .integer(1) && Self.string($0, "deleted_at") == nil
        }) else { throw NativeTinfoilOAuthError.modelUnavailable }

        if let connectionID = Self.string(model, "provider_connection_id") {
            guard let connection = connectionRows.first(where: { $0.id == connectionID }),
                  Self.string(connection, "provider") == "tinfoil",
                  Self.string(connection, "auth_method") == "oauth",
                  Self.integer(connection, "enabled") == 1,
                  Self.string(connection, "deleted_at") == nil,
                  let binding = Self.string(connectionSecretRows.first(where: { $0.id == connectionID }), "binding"),
                  binding == Self.binding(for: connection),
                  let raw = Self.string(connectionSecretRows.first(where: { $0.id == connectionID }), "credentials") else {
                throw NativeTinfoilOAuthError.credentialUnavailable
            }
            return try Self.snapshot(location: .providerConnection(id: connectionID, binding: binding), raw: raw)
        }

        guard Self.string(modelSecretRows.first(where: { $0.id == modelID }), "oauth_provider") == "tinfoil",
              let integration = integrationRows.first(where: { $0.id == "tinfoil" }),
              Self.integer(integration, "enabled") == 1,
              let raw = Self.string(integration, "credentials") else {
            throw NativeTinfoilOAuthError.credentialUnavailable
        }
        return try Self.snapshot(
            location: .integration(id: "tinfoil", enabled: 1),
            raw: raw
        )
    }

    private func refreshAndPersist(_ snapshot: CredentialSnapshot, refreshToken: String) async throws -> String {
        do {
            let tokens = try await refresher.refresh(refreshToken: refreshToken)
            var credentials = try Self.jsonDictionary(snapshot.raw)
            credentials["access_token"] = tokens.accessToken
            credentials["refresh_token"] = tokens.refreshToken ?? refreshToken
            credentials["expires_at"] = (now() + tokens.expiresIn) * 1000
            credentials.removeValue(forKey: "reauth_required")
            try await persist(credentials, expected: snapshot)
            return tokens.accessToken
        } catch NativeTinfoilOAuthError.reauthorizationRequired {
            try await markReauthorizationRequired(snapshot)
            throw NativeTinfoilOAuthError.reauthorizationRequired
        }
    }

    private func markReauthorizationRequired(_ snapshot: CredentialSnapshot) async throws {
        var credentials = try Self.jsonDictionary(snapshot.raw)
        credentials["reauth_required"] = true
        try await persist(credentials, expected: snapshot)
    }

    private func persist(_ credentials: [String: Any], expected: CredentialSnapshot) async throws {
        switch expected.location {
        case .providerConnection(let id, let binding):
            do {
                try await store.compareAndWriteLocal(
                    table: "provider_connection_secrets", id: id,
                    expected: ["credentials": .text(expected.raw), "binding": .text(binding)],
                    values: ["credentials": .text(try Self.jsonString(credentials)), "binding": .text(binding)]
                )
            } catch NativeSyncStoreError.rowChanged(_, _) {
                throw NativeTinfoilOAuthError.connectionChanged
            }
        case .integration(let id, let enabled):
            do {
                try await store.compareAndWriteLocal(
                    table: "integrations_secrets", id: id,
                    expected: ["credentials": .text(expected.raw), "enabled": .integer(enabled)],
                    values: ["credentials": .text(try Self.jsonString(credentials)), "enabled": .integer(enabled)]
                )
            } catch NativeSyncStoreError.rowChanged(_, _) {
                throw NativeTinfoilOAuthError.connectionChanged
            }
        }
    }

    private static func snapshot(location: CredentialLocation, raw: String) throws -> CredentialSnapshot {
        let values = try jsonDictionary(raw)
        guard let accessToken = values["access_token"] as? String, !accessToken.isEmpty else {
            throw NativeTinfoilOAuthError.credentialUnavailable
        }
        let numericExpiry = (values["expires_at"] as? NSNumber)?.doubleValue ?? 0
        return CredentialSnapshot(
            location: location,
            raw: raw,
            accessToken: accessToken,
            refreshToken: values["refresh_token"] as? String,
            expiresAt: numericExpiry,
            reauthorizationRequired: values["reauth_required"] as? Bool == true
        )
    }

    private static func jsonDictionary(_ value: String) throws -> [String: Any] {
        guard let data = value.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NativeTinfoilOAuthError.credentialUnavailable
        }
        return object
    }

    private static func jsonString(_ value: [String: Any]) throws -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let string = String(data: data, encoding: .utf8) else {
            throw NativeTinfoilOAuthError.refreshFailed
        }
        return string
    }

    private static func binding(for connection: NativeSyncRow) -> String? {
        guard let provider = string(connection, "provider"),
              let authMethod = string(connection, "auth_method") else { return nil }
        let url: Any = string(connection, "url") as Any? ?? NSNull()
        guard let data = try? JSONSerialization.data(withJSONObject: [provider, authMethod, url], options: [.fragmentsAllowed]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func string(_ row: NativeSyncRow?, _ key: String) -> String? {
        guard case .text(let value)? = row?.values[key] else { return nil }
        return value
    }

    private static func integer(_ row: NativeSyncRow?, _ key: String) -> Int64? {
        guard case .integer(let value)? = row?.values[key] else { return nil }
        return value
    }
}
