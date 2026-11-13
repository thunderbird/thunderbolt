/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Observation

enum NativeMCPTransportKind: String, CaseIterable, Identifiable, Sendable {
    case http
    case sse
    case iroh

    var id: String { rawValue }
}

struct NativeMCPServer: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let type: NativeMCPTransportKind
    let url: String
    let enabled: Bool
    let credentialType: String?
}

struct NativeMCPToolDescriptor: Codable, Equatable, Sendable {
    let serverID: String
    let serverName: String
    let serverURL: String
    let name: String
    let toolName: String
    let description: String?
    let inputSchema: ChatJSONValue
}

enum NativeMCPStoredCredentials: Codable, Equatable, Sendable {
    case bearer(token: String)
    case oauth(accessToken: String, refreshToken: String?, expiresAt: Double?, clientID: String?, issuer: String?, tokenEndpoint: String?, scope: String?)

    private enum Keys: String, CodingKey {
        case type, token, accessToken = "access_token", refreshToken = "refresh_token"
        case expiresAt = "expires_at", clientID = "clientId", issuer, tokenEndpoint, scope
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "bearer": self = .bearer(token: try container.decode(String.self, forKey: .token))
        case "oauth":
            self = .oauth(
                accessToken: try container.decode(String.self, forKey: .accessToken),
                refreshToken: try container.decodeIfPresent(String.self, forKey: .refreshToken),
                expiresAt: try container.decodeIfPresent(Double.self, forKey: .expiresAt),
                clientID: try container.decodeIfPresent(String.self, forKey: .clientID),
                issuer: try container.decodeIfPresent(String.self, forKey: .issuer),
                tokenEndpoint: try container.decodeIfPresent(String.self, forKey: .tokenEndpoint),
                scope: try container.decodeIfPresent(String.self, forKey: .scope)
            )
        default: throw NativeMCPError.invalidResponse
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        switch self {
        case .bearer(let token):
            try container.encode("bearer", forKey: .type)
            try container.encode(token, forKey: .token)
        case .oauth(let accessToken, let refreshToken, let expiresAt, let clientID, let issuer, let tokenEndpoint, let scope):
            try container.encode("oauth", forKey: .type)
            try container.encode(accessToken, forKey: .accessToken)
            try container.encodeIfPresent(refreshToken, forKey: .refreshToken)
            try container.encodeIfPresent(expiresAt, forKey: .expiresAt)
            try container.encodeIfPresent(clientID, forKey: .clientID)
            try container.encodeIfPresent(issuer, forKey: .issuer)
            try container.encodeIfPresent(tokenEndpoint, forKey: .tokenEndpoint)
            try container.encodeIfPresent(scope, forKey: .scope)
        }
    }

    var bearerToken: String? {
        switch self {
        case .bearer(let token): token
        case .oauth(let accessToken, _, _, _, _, _, _): accessToken
        }
    }

    var kind: String {
        switch self {
        case .bearer: "bearer"
        case .oauth: "oauth"
        }
    }
}

/// MCP server definitions and credentials mirror the Tauri local-only tables.
actor NativeMCPRepository {
    private let store: NativeSyncStore

    init(store: NativeSyncStore) { self.store = store }

    func load() async throws -> [NativeMCPServer] {
        async let servers = store.readAll(table: "mcp_servers")
        async let secrets = store.readAll(table: "mcp_secrets")
        let (serverRows, secretRows) = try await (servers, secrets)
        let credentialKinds: [String: String] = Dictionary(uniqueKeysWithValues: secretRows.compactMap { row -> (String, String)? in
            guard case .text(let json)? = row.values["credentials"],
                  let credential = try? JSONDecoder().decode(NativeMCPStoredCredentials.self, from: Data(json.utf8)) else { return nil }
            return (row.id, credential.kind)
        })
        let decodedServers: [NativeMCPServer] = serverRows.compactMap { row -> NativeMCPServer? in
            guard case .text(let name)? = row.values["name"],
                  case .text(let typeText)? = row.values["type"],
                  let type = NativeMCPTransportKind(rawValue: typeText),
                  case .text(let url)? = row.values["url"] else { return nil }
            let enabled = row.values["enabled"] == .integer(1)
            return NativeMCPServer(id: row.id, name: name, type: type, url: url, enabled: enabled,
                                   credentialType: credentialKinds[row.id])
        }
        return decodedServers.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func credentials(for id: String) async throws -> NativeMCPStoredCredentials? {
        guard let row = try await store.read(table: "mcp_secrets", id: id),
              case .text(let json)? = row.values["credentials"] else { return nil }
        return try JSONDecoder().decode(NativeMCPStoredCredentials.self, from: Data(json.utf8))
    }

    func serverURL(for id: String) async throws -> String? {
        guard let row = try await store.read(table: "mcp_servers", id: id),
              case .text(let url)? = row.values["url"], row.values["deleted_at"] == .null else { return nil }
        return url
    }

    func setCredentials(_ credential: NativeMCPStoredCredentials, for id: String, expectedURL: String) async throws {
        guard try await serverURL(for: id) == expectedURL else { throw NativeMCPOAuthError.serverChanged }
        try await store.write(table: "mcp_secrets", id: id, values: [
            "credentials": .text(String(decoding: try JSONEncoder().encode(credential), as: UTF8.self)),
        ])
    }

    func replaceCredentials(_ credential: NativeMCPStoredCredentials, for id: String, expected: NativeMCPStoredCredentials) async throws {
        guard let current = try await store.read(table: "mcp_secrets", id: id),
              case .text(let serialized)? = current.values["credentials"] else { throw NativeMCPOAuthError.serverChanged }
        guard let currentCredentials = try? JSONDecoder().decode(NativeMCPStoredCredentials.self, from: Data(serialized.utf8)),
              currentCredentials == expected else { throw NativeMCPOAuthError.serverChanged }
        try await store.compareAndWriteLocal(
            table: "mcp_secrets", id: id, expected: ["credentials": .text(serialized)],
            values: ["credentials": .text(String(decoding: try JSONEncoder().encode(credential), as: UTF8.self))]
        )
    }

    func save(id: String? = nil, name rawName: String, url rawURL: String, type: NativeMCPTransportKind,
              enabled: Bool = true, credentials: NativeMCPStoredCredentials?) async throws -> String {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        let url = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let parsedURL = URL(string: url) else { throw NativeMCPError.invalidURL }
        if type != .iroh { try NativeMCPClient.validate(parsedURL) }
        let identity = id ?? UUID().uuidString.lowercased()
        let timestamp = ISO8601DateFormatter().string(from: Date())
        var mutations = [NativeSyncMutation(table: "mcp_servers", id: identity, values: [
            "name": .text(name), "type": .text(type.rawValue), "url": .text(parsedURL.absoluteString),
            "enabled": .integer(enabled ? 1 : 0), "created_at": .text(timestamp), "updated_at": .text(timestamp),
            "deleted_at": .null,
        ])]
        if let credentials {
            mutations.append(NativeSyncMutation(table: "mcp_secrets", id: identity, values: [
                "credentials": .text(String(decoding: try JSONEncoder().encode(credentials), as: UTF8.self)),
            ]))
        }
        try await store.writeTransaction(mutations)
        return identity
    }

    func setEnabled(id: String, enabled: Bool) async throws {
        try await store.write(table: "mcp_servers", id: id, values: [
            "enabled": .integer(enabled ? 1 : 0), "updated_at": .text(ISO8601DateFormatter().string(from: Date())),
        ])
    }

    func clearCredentials(for id: String) async throws {
        try await store.write(table: "mcp_secrets", id: id, values: ["credentials": .null])
    }

    func delete(id: String) async throws {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        try await store.writeTransaction([
            NativeSyncMutation(table: "mcp_servers", id: id, values: [
                "name": .null, "type": .null, "url": .null, "command": .null, "args": .null,
                "enabled": .integer(0), "updated_at": .text(timestamp), "deleted_at": .text(timestamp),
            ]),
            NativeSyncMutation(table: "mcp_secrets", id: id, values: ["credentials": .null]),
        ])
    }
}

@MainActor
@Observable
final class NativeMCPLibrary {
    private(set) var servers: [NativeMCPServer] = []
    private(set) var toolsByServer: [String: [NativeMCPTool]] = [:]
    private(set) var discoveryErrors: [String: String] = [:]
    private(set) var isWorking = false
    var error: String?

    @ObservationIgnored private let repository: NativeMCPRepository
    @ObservationIgnored private let client: NativeMCPClient
    @ObservationIgnored private let oauth: NativeMCPOAuthCoordinator
    @ObservationIgnored private var generation = 0

    init(store: NativeSyncStore, accountServer: String, userID: String, client: NativeMCPClient = NativeMCPClient()) {
        let repository = NativeMCPRepository(store: store)
        self.repository = repository
        oauth = NativeMCPOAuthCoordinator(repository: repository, accountServer: accountServer, userID: userID)
        self.client = client
    }

    var pendingOAuthServerID: String? { oauth.pendingServerID }
    var oauthError: String? { oauth.error }

    func reload() async {
        do { servers = try await repository.load(); error = nil }
        catch let caughtError { self.error = caughtError.localizedDescription }
    }

    func save(id: String? = nil, name: String, url: String, type: NativeMCPTransportKind,
              bearerToken: String, enabled: Bool = true) async {
        await perform { [self] in
            let credential = bearerToken.isEmpty ? nil : NativeMCPStoredCredentials.bearer(token: bearerToken)
            _ = try await self.repository.save(id: id, name: name, url: url, type: type, enabled: enabled, credentials: credential)
            self.servers = try await self.repository.load()
        }
    }

    func setEnabled(_ server: NativeMCPServer, enabled: Bool) async {
        await perform { [self] in try await self.repository.setEnabled(id: server.id, enabled: enabled); self.servers = try await self.repository.load() }
    }

    func remove(_ server: NativeMCPServer) async {
        await perform { [self] in try await self.repository.delete(id: server.id); self.servers = try await self.repository.load(); self.toolsByServer[server.id] = nil }
    }

    func disconnectCredentials(for server: NativeMCPServer) async {
        await perform { [self] in try await self.repository.clearCredentials(for: server.id); self.servers = try await self.repository.load() }
    }

    func test(_ server: NativeMCPServer) async {
        let requestGeneration = generation
        await perform { [self] in
            let token: String?
            if let refreshed = try await self.oauth.accessToken(for: server.id) { token = refreshed }
            else { token = try await self.repository.credentials(for: server.id)?.bearerToken }
            let tools = try await self.client.listTools(serverURL: URL(string: server.url)!, transport: server.type.rawValue, bearerToken: token)
            guard requestGeneration == self.generation else { return }
            self.toolsByServer[server.id] = tools
        }
    }

    func callTool(serverID: String, name: String, arguments: [String: ChatJSONValue]) async throws -> NativeMCPToolResult {
        guard let server = servers.first(where: { $0.id == serverID }), server.enabled else { throw NativeMCPError.invalidResponse }
        let token: String?
        if let refreshed = try await oauth.accessToken(for: serverID) { token = refreshed }
        else { token = try await repository.credentials(for: serverID)?.bearerToken }
        return try await client.callTool(serverURL: URL(string: server.url)!, transport: server.type.rawValue,
                                         bearerToken: token, name: name, arguments: arguments)
    }

    func prepareTools() async throws -> [NativeMCPToolDescriptor] {
        let requestGeneration = generation
        let loadedServers = try await repository.load()
        try Task.checkCancellation()
        guard requestGeneration == generation else { throw CancellationError() }
        servers = loadedServers
        let enabledServers = loadedServers.filter { $0.enabled }.sorted { $0.id < $1.id }
        discoveryErrors = [:]
        for server in enabledServers {
            try Task.checkCancellation()
            guard requestGeneration == generation else { throw CancellationError() }
            do {
                let token: String?
                if let refreshed = try await oauth.accessToken(for: server.id) { token = refreshed }
                else { token = try await repository.credentials(for: server.id)?.bearerToken }
                try Task.checkCancellation()
                guard requestGeneration == generation else { throw CancellationError() }
                let tools = try await client.listTools(
                    serverURL: URL(string: server.url)!, transport: server.type.rawValue, bearerToken: token
                )
                try Task.checkCancellation()
                guard requestGeneration == generation else { throw CancellationError() }
                toolsByServer[server.id] = tools
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                guard requestGeneration == generation else { throw CancellationError() }
                toolsByServer[server.id] = []
                discoveryErrors[server.id] = error.localizedDescription
                continue
            }
        }
        guard requestGeneration == generation else { throw CancellationError() }
        return Self.makeToolDescriptors(servers: enabledServers, toolsByServer: toolsByServer)
    }

    func reset() {
        generation &+= 1
        toolsByServer = [:]
        discoveryErrors = [:]
        oauth.clearPending()
    }

    func beginOAuth(serverID: String) async throws -> URL {
        let requestGeneration = generation
        guard let server = servers.first(where: { $0.id == serverID }) else { throw NativeMCPOAuthError.serverChanged }
        let url = try await oauth.begin(server: server)
        guard requestGeneration == generation else { throw CancellationError() }
        return url
    }

    func handleOAuthCallback(_ url: URL) async -> Bool {
        let handled = await oauth.handleCallback(url)
        if handled { await reload() }
        return handled
    }

    func clearPendingOAuth() { oauth.clearPending() }

    private func perform(_ operation: @escaping () async throws -> Void) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do { try await operation(); error = nil }
        catch let caughtError { self.error = caughtError.localizedDescription }
    }

    static func makeToolDescriptors(servers: [NativeMCPServer], toolsByServer: [String: [NativeMCPTool]]) -> [NativeMCPToolDescriptor] {
        var usedPrefixes: Set<String> = []
        var usedNames: Set<String> = []
        var descriptors: [NativeMCPToolDescriptor] = []
        for server in servers.sorted(by: { $0.id < $1.id }) {
            let basePrefix = sanitizePrefix(server.name)
            var prefix = basePrefix
            var suffix = 2
            while usedPrefixes.contains(prefix) {
                prefix = "\(basePrefix)_\(suffix)"
                suffix += 1
            }
            usedPrefixes.insert(prefix)
            for tool in toolsByServer[server.id] ?? [] {
                let name = "\(prefix)_\(tool.name)"
                guard usedNames.insert(name).inserted else { continue }
                descriptors.append(NativeMCPToolDescriptor(
                    serverID: server.id, serverName: server.name, serverURL: server.url,
                    name: name, toolName: tool.name,
                    description: tool.description, inputSchema: tool.inputSchema
                ))
            }
        }
        return descriptors
    }

    private static func sanitizePrefix(_ name: String?) -> String {
        let prefix = (name ?? "").lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
            .replacingOccurrences(of: "^_|_$", with: "", options: .regularExpression)
        return prefix.isEmpty ? "mcp" : prefix
    }
}
