/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Observation

enum NativeACPAgentType: String, CaseIterable, Sendable {
    case builtIn = "built-in"
    case remote = "remote-acp"
    case managed = "managed-acp"
    case hosted = "managed-http"
}

enum NativeACPAgentTransport: String, CaseIterable, Sendable {
    case websocket
    case iroh
    case http
}

struct NativeACPAgent: Identifiable, Equatable, Sendable {
    let id: String
    var name: String
    var type: NativeACPAgentType
    var transport: NativeACPAgentTransport
    var url: String
    var description: String?
    var icon: String?
    var enabled: Bool
    var isSystem: Bool
    var isDefault: Bool
    var deletedAt: String?

    var canConnectOverWebSocket: Bool {
        transport == .websocket && (type == .remote || type == .managed)
    }
}

struct NativeACPAgentSecrets: Equatable, Sendable {
    var apiKey: String?
    var authMethod: String?
}

struct NativeAgentDiscoveryResponse: Decodable, Sendable {
    let version: String
    let agents: [NativeAgentDiscoveryDescriptor]
    let allowCustomAgents: Bool
    let defaultAgentId: String?
}

struct NativeAgentDiscoveryDescriptor: Decodable, Sendable {
    let id: String
    let name: String
    let type: String
    let transport: String
    let url: String
    let description: String?
    let icon: String?
    let isSystem: Int
}

enum NativeAgentDiscoveryResult: Sendable, Equatable {
    case refreshed(defaultAgentID: String?, allowCustomAgents: Bool)
    case ignoredAsStale
}

enum NativeAgentsError: Error, LocalizedError, Equatable {
    case invalidName
    case invalidWebSocketURL
    case invalidDiscoveryResponse
    case agentUnavailable
    case unsupportedTransport

    var errorDescription: String? {
        switch self {
        case .invalidName: nativeString("Enter an agent name.")
        case .invalidWebSocketURL: nativeString("Enter a valid wss:// URL. iOS does not allow insecure ws:// agents.")
        case .invalidDiscoveryResponse: nativeString("The server returned an invalid agent list.")
        case .agentUnavailable: nativeString("This agent is no longer available.")
        case .unsupportedTransport: nativeString("This agent transport is not available in the native app.")
        }
    }
}

/// Reads the existing synced agent tables and their existing device-local secrets table.
@MainActor
@Observable
final class NativeAgentsLibrary {
    private(set) var agents: [NativeACPAgent] = []
    private(set) var error: String?

    @ObservationIgnored private let store: NativeSyncStore
    @ObservationIgnored private let userID: String
    @ObservationIgnored private let builtInAgentEnabled: Bool
    @ObservationIgnored private let appName: String
    @ObservationIgnored private var watcher: Task<Void, Never>?
    @ObservationIgnored private var discoveryGeneration = 0
    private(set) var allowCustomAgents = true

    init(store: NativeSyncStore, userID: String, builtInAgentEnabled: Bool = true, appName: String = "Thunderbolt") {
        self.store = store
        self.userID = userID
        self.builtInAgentEnabled = builtInAgentEnabled
        self.appName = appName
    }

    func start() {
        guard watcher == nil else { return }
        watcher = Task { [weak self, store, userID] in
            do {
                async let custom = store.watch(table: "agents")
                async let system = store.watch(table: "agents_system")
                let customStream = try await custom
                let systemStream = try await system
                async let customTask: Void = Self.consume(customStream, includeDeleted: false) { [weak self] rows in
                    await MainActor.run { self?.apply(customRows: rows, systemRows: self?.systemRows ?? [], userID: userID) }
                }
                async let systemTask: Void = Self.consume(systemStream, includeDeleted: false) { [weak self] rows in
                    await MainActor.run { self?.apply(customRows: self?.customRows ?? [], systemRows: rows, userID: userID) }
                }
                _ = await (customTask, systemTask)
            } catch is CancellationError {
            } catch { self?.error = error.localizedDescription }
        }
    }

    private var customRows: [NativeSyncRow] = []
    private var systemRows: [NativeSyncRow] = []

    func stop() {
        discoveryGeneration += 1
        watcher?.cancel()
        watcher = nil
        customRows = []
        systemRows = []
        agents = []
        error = nil
    }

    func refresh() async throws {
        let custom = try await store.readAll(table: "agents")
        let system = try await store.readAll(table: "agents_system")
        apply(customRows: custom, systemRows: system, userID: userID)
    }

    /// Call before starting a `/agents` request; the returned generation fences
    /// stale anonymous/account responses and canceled bootstrap work.
    func beginSystemDiscoveryRefresh() -> Int {
        discoveryGeneration += 1
        return discoveryGeneration
    }

    /// Replaces the ephemeral system-agent cache only for a complete, current
    /// versioned response. Network and decode failures should leave cached rows
    /// untouched; 401/403 callers pass an empty valid response to clear it.
    func reconcileSystemAgents(
        _ response: NativeAgentDiscoveryResponse,
        generation: Int,
        fetchedAt: Date = Date()
    ) async throws -> NativeAgentDiscoveryResult {
        guard generation == discoveryGeneration, !Task.isCancelled else { return .ignoredAsStale }
        guard response.version == "1", Set(response.agents.map(\.id)).count == response.agents.count,
              response.agents.allSatisfy({ !$0.id.isEmpty && !$0.name.isEmpty && !$0.url.isEmpty }) else {
            throw NativeAgentsError.invalidDiscoveryResponse
        }
        let stored = response.agents.compactMap { agent -> NativeSystemAgentCacheEntry? in
            guard agent.isSystem == 1,
                  agent.type == NativeACPAgentType.managed.rawValue || agent.type == NativeACPAgentType.hosted.rawValue,
                  let transport = Self.systemTransport(agent.type, wireTransport: agent.transport) else { return nil }
            if agent.type == NativeACPAgentType.hosted.rawValue {
                guard agent.url.hasPrefix("/"), !agent.url.hasPrefix("//") else { return nil }
            }
            return NativeSystemAgentCacheEntry(
                id: agent.id, name: agent.name, type: agent.type, transport: transport,
                url: agent.url, description: agent.description, icon: agent.icon,
                fetchedAt: ISO8601DateFormatter().string(from: fetchedAt),
                isDefault: agent.id == response.defaultAgentId
            )
        }
        guard generation == discoveryGeneration, !Task.isCancelled else { return .ignoredAsStale }
        try await store.replaceSystemAgentCache(stored)
        guard generation == discoveryGeneration, !Task.isCancelled else { return .ignoredAsStale }
        allowCustomAgents = response.allowCustomAgents
        try await refresh()
        let defaultID = response.defaultAgentId.flatMap { id in stored.contains(where: { $0.id == id }) ? id : nil }
        return .refreshed(defaultAgentID: defaultID, allowCustomAgents: response.allowCustomAgents)
    }

    var preferredDefaultAgentID: String? {
        agents.first(where: { $0.isDefault })?.id ?? agents.first(where: { $0.type == .builtIn })?.id
    }

    func isActive(id: String) async throws -> Bool {
        guard let agent = agents.first(where: { $0.id == id }) else { return false }
        if agent.type == .builtIn || agent.isSystem { return true }
        guard let row = try await store.read(table: "agents", id: id) else { return false }
        return row.values["user_id"] == .text(userID)
            && row.values["deleted_at"]?.text == nil
            && row.values["enabled"] == .integer(1)
    }

    func add(name: String, url: String, description: String? = nil, type: NativeACPAgentType = .remote) async throws -> String {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty else { throw NativeAgentsError.invalidName }
        let cleanURL = try Self.validatedWebSocketURL(url)
        let id = UUID().uuidString.lowercased()
        try await store.write(table: "agents", id: id, values: [
            "name": .text(cleanName), "type": .text(type.rawValue), "transport": .text("websocket"),
            "url": .text(cleanURL), "description": Self.text(description), "icon": .null,
            "enabled": .integer(1), "deleted_at": .null, "user_id": .text(userID),
        ])
        return id
    }

    func update(_ id: String, name: String, url: String, description: String?, type: NativeACPAgentType) async throws {
        guard let current = agents.first(where: { $0.id == id && !$0.isSystem && $0.deletedAt == nil }) else {
            throw NativeAgentsError.agentUnavailable
        }
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty else { throw NativeAgentsError.invalidName }
        let cleanURL = try Self.validatedWebSocketURL(url)
        var changes: [String: NativeSyncValue] = [
            "name": .text(cleanName), "url": .text(cleanURL), "description": Self.text(description),
            "type": .text(type.rawValue), "transport": .text("websocket"),
        ]
        if current.url != cleanURL || current.type != type || current.transport != .websocket {
            let threads = try await store.readAll(table: "chat_threads")
            let clears = threads.filter { $0.values["agent_id"] == .text(id) }.map {
                NativeSyncMutation(table: "chat_threads", id: $0.id, values: ["acp_session_id": .null])
            }
            try await store.writeTransaction(clears + [NativeSyncMutation(table: "agents", id: id, values: changes)])
            return
        }
        changes["enabled"] = .integer(current.enabled ? 1 : 0)
        try await store.write(table: "agents", id: id, values: changes)
    }

    func setEnabled(_ enabled: Bool, id: String) async throws {
        guard agents.contains(where: { $0.id == id && !$0.isSystem && $0.deletedAt == nil }) else {
            throw NativeAgentsError.agentUnavailable
        }
        try await store.write(table: "agents", id: id, values: ["enabled": .integer(enabled ? 1 : 0)])
        if !enabled { try await clearSessions(for: id) }
    }

    func delete(_ id: String) async throws {
        guard agents.contains(where: { $0.id == id && !$0.isSystem && $0.deletedAt == nil }) else {
            throw NativeAgentsError.agentUnavailable
        }
        try await store.write(table: "agents", id: id, values: ["deleted_at": .text(Date().ISO8601Format())])
        try await clearSessions(for: id)
    }

    func secrets(for agentID: String) async throws -> NativeACPAgentSecrets? {
        guard let row = try await store.read(table: "agents_secrets", id: agentID) else { return nil }
        return NativeACPAgentSecrets(apiKey: row.values["api_key"]?.text, authMethod: row.values["auth_method"]?.text)
    }

    func saveSecrets(_ secrets: NativeACPAgentSecrets, for agentID: String) async throws {
        guard agents.contains(where: { $0.id == agentID }) else { throw NativeAgentsError.agentUnavailable }
        try await store.write(table: "agents_secrets", id: agentID, values: [
            "api_key": Self.text(secrets.apiKey), "auth_method": Self.text(secrets.authMethod),
        ])
    }

    private func clearSessions(for agentID: String) async throws {
        let threads = try await store.readAll(table: "chat_threads")
        let updates = threads.filter { $0.values["agent_id"] == .text(agentID) }.map {
            NativeSyncMutation(table: "chat_threads", id: $0.id, values: ["acp_session_id": .null])
        }
        try await store.writeTransaction(updates)
    }

    private func apply(customRows: [NativeSyncRow], systemRows: [NativeSyncRow], userID: String) {
        self.customRows = customRows
        self.systemRows = systemRows
        let customAgents = customRows.compactMap { row -> NativeACPAgent? in
            guard row.values["user_id"] == .text(userID), row.values["deleted_at"]?.text == nil else { return nil }
            let rawType = row.values["type"]?.text ?? "remote-acp"
            let type: NativeACPAgentType = rawType == NativeACPAgentType.managed.rawValue ? .managed : .remote
            let rawTransport = row.values["transport"]?.text
            let transport: NativeACPAgentTransport = rawTransport == NativeACPAgentTransport.iroh.rawValue ? .iroh : .websocket
            return NativeACPAgent(
                id: row.id, name: row.values["name"]?.text ?? "", type: type, transport: transport,
                url: row.values["url"]?.text ?? "", description: row.values["description"]?.text,
                icon: row.values["icon"]?.text, enabled: row.values["enabled"] == .integer(1),
                isSystem: false, isDefault: false, deletedAt: row.values["deleted_at"]?.text
            )
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        let systemAgents = systemRows.compactMap { row -> NativeACPAgent? in
            guard let rawType = row.values["type"]?.text,
                  let type = NativeACPAgentType(rawValue: rawType), type != .remote,
                  let rawTransport = row.values["transport"]?.text,
                  let transport = NativeACPAgentTransport(rawValue: rawTransport) else { return nil }
            return NativeACPAgent(
                id: row.id, name: row.values["name"]?.text ?? "", type: type, transport: transport,
                url: row.values["url"]?.text ?? "", description: row.values["description"]?.text,
                icon: row.values["icon"]?.text, enabled: true, isSystem: true,
                isDefault: row.values["is_default"] == .integer(1), deletedAt: nil
            )
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        let builtIn = builtInAgentEnabled ? [NativeACPAgent(
            id: "thunderbolt-built-in", name: appName, type: .builtIn, transport: .websocket,
            url: "", description: nativeString("Built-in AI assistant"), icon: "zap",
            enabled: true, isSystem: true, isDefault: false, deletedAt: nil
        )] : []
        agents = builtIn + systemAgents + customAgents
    }

    private static func consume(
        _ stream: AsyncThrowingStream<[NativeSyncRow], Error>,
        includeDeleted: Bool,
        onRows: @escaping @Sendable ([NativeSyncRow]) async -> Void
    ) async {
        _ = includeDeleted
        do { for try await rows in stream { await onRows(rows) } }
        catch is CancellationError {}
        catch {}
    }

    private static func validatedWebSocketURL(_ value: String) throws -> String {
        let candidate = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: candidate), url.scheme?.lowercased() == "wss",
              url.host != nil, url.user == nil, url.password == nil else { throw NativeAgentsError.invalidWebSocketURL }
        return candidate
    }

    private static func systemTransport(_ type: String, wireTransport: String) -> String? {
        if type == NativeACPAgentType.hosted.rawValue { return wireTransport == "http" ? "http" : nil }
        return wireTransport == "websocket" || wireTransport == "iroh" ? wireTransport : nil
    }

    private static func text(_ value: String?) -> NativeSyncValue {
        guard let value, !value.isEmpty else { return .null }
        return .text(value)
    }
}
