/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Observation

struct NativeProject: Identifiable, Equatable, Sendable {
    var id = ChronologicalID.shared.next()
    var name = ""
    var description = ""
    var instructions = ""
    var icon = ""
    var pinnedOrder: Int64?
    var createdAt = Date()
    var updatedAt = Date()

    var promptSection: String? {
        let content = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return nil }
        return [
            "# Project: \(name)",
            "The user is working inside this project. Its instructions apply to every message in this conversation.",
            "## Project instructions\n\(content)",
        ].joined(separator: "\n\n")
    }
}

@MainActor
@Observable
final class ProjectLibrary {
    private(set) var projects: [NativeProject] = []
    var error: String?
    @ObservationIgnored private let store: NativeSyncStore
    @ObservationIgnored private let userID: String
    @ObservationIgnored private var watcher: Task<Void, Never>?

    init(store: NativeSyncStore, userID: String) {
        self.store = store
        self.userID = userID
    }

    func start() {
        guard watcher == nil else { return }
        let store = store
        let userID = userID
        watcher = Task { [weak self] in
            do {
                for try await rows in try await store.watch(table: "projects") {
                    guard !Task.isCancelled else { return }
                    self?.projects = rows.filter { $0.values["user_id"] == .text(userID) }.map(Self.decode)
                }
            } catch is CancellationError {
            } catch { self?.error = error.localizedDescription }
        }
    }

    func stop() { watcher?.cancel(); watcher = nil; projects = [] }

    func save(_ project: NativeProject) async throws {
        let name = project.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw ProjectError.emptyName }
        var values: [String: NativeSyncValue] = [
            "user_id": .text(userID), "name": .text(name), "description": .text(project.description),
            "instructions": .text(project.instructions), "icon": .text(project.icon),
            "created_at": .text(project.createdAt.ISO8601Format()), "updated_at": .text(Date().ISO8601Format()),
        ]
        if try await store.read(table: "projects", id: project.id) == nil { values["pinned_order"] = .null }
        try await store.write(table: "projects", id: project.id, values: values)
    }

    func togglePin(_ project: NativeProject) async throws {
        let order = project.pinnedOrder == nil ? (projects.compactMap(\.pinnedOrder).max() ?? -1) + 1 : nil
        try await store.write(table: "projects", id: project.id, values: [
            "user_id": .text(userID), "pinned_order": order.map(NativeSyncValue.integer) ?? .null,
        ])
    }

    /// Removing a project only orphans its conversations. Chat deletion is a
    /// separate user action, matching the existing Tauri project transaction.
    func delete(_ project: NativeProject) async throws {
        let rows = try await store.readAll(table: "chat_threads")
        let moves = rows.filter { $0.values["project_id"] == .text(project.id) }.map {
            NativeSyncMutation(table: "chat_threads", id: $0.id, values: ["user_id": .text(userID), "project_id": .null])
        }
        var tombstone = Dictionary(uniqueKeysWithValues: NativePowerSyncSchema.byName["projects"]!.columns.map { ($0.name, NativeSyncValue.null) })
        tombstone["user_id"] = .text(userID)
        tombstone["deleted_at"] = .text(Date().ISO8601Format())
        try await store.writeTransaction(moves + [NativeSyncMutation(table: "projects", id: project.id, values: tombstone)])
    }

    func sorted(conversations: [Conversation]) -> [NativeProject] {
        let activity = Dictionary(grouping: conversations.filter { $0.deletedAt == nil }) { $0.projectID ?? "" }
            .mapValues { $0.map(\.updatedAt).max() ?? .distantPast }
        return projects.sorted { lhs, rhs in
            if lhs.pinnedOrder != rhs.pinnedOrder {
                if let left = lhs.pinnedOrder, let right = rhs.pinnedOrder { return left < right }
                return lhs.pinnedOrder != nil
            }
            let left = max(lhs.createdAt, activity[lhs.id] ?? .distantPast)
            let right = max(rhs.createdAt, activity[rhs.id] ?? .distantPast)
            return left == right ? lhs.id > rhs.id : left > right
        }
    }

    private static func decode(_ row: NativeSyncRow) -> NativeProject {
        let created = row.values["created_at"]?.text.flatMap { try? Date($0, strategy: .iso8601) }
            ?? ChronologicalID.date(from: row.id) ?? .distantPast
        let pinned: Int64?
        if case .integer(let value)? = row.values["pinned_order"] { pinned = value } else { pinned = nil }
        return NativeProject(id: row.id, name: row.values["name"]?.text ?? "",
            description: row.values["description"]?.text ?? "", instructions: row.values["instructions"]?.text ?? "",
            icon: row.values["icon"]?.text ?? "", pinnedOrder: pinned, createdAt: created,
            updatedAt: row.values["updated_at"]?.text.flatMap { try? Date($0, strategy: .iso8601) } ?? created)
    }
}

enum ProjectError: LocalizedError {
    case emptyName
    var errorDescription: String? { nativeString( "Enter a project name.") }
}
