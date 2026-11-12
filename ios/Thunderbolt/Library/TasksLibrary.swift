/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Observation

struct NativeTask: Identifiable, Equatable, Sendable {
    let id: String
    var item: String
    var order: Int64
    var isComplete: Bool
    var defaultHash: String?
    var deletedAt: String?
}

enum NativeTasksError: Error, LocalizedError, Equatable {
    case emptyItem, missingTask, invalidMove

    var errorDescription: String? {
        switch self {
        case .emptyItem: nativeString( "Enter a task before saving it.")
        case .missingTask: nativeString( "This task is no longer available.")
        case .invalidMove: nativeString( "The task order could not be updated.")
        }
    }
}

/// Local-first task actions backed by the encrypted, user-scoped PowerSync table.
@MainActor
@Observable
final class TasksLibrary {
    private(set) var tasks: [NativeTask] = []
    private(set) var error: String?
    var searchQuery = ""

    @ObservationIgnored private let store: NativeSyncStore
    @ObservationIgnored private let userID: String
    @ObservationIgnored private var watcher: Task<Void, Never>?

    init(store: NativeSyncStore, userID: String) {
        self.store = store
        self.userID = userID
    }

    var incompleteCount: Int { incompleteTasks.count }

    var visibleTasks: [NativeTask] {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let matching = incompleteTasks.filter { task in
            guard !query.isEmpty else { return true }
            return task.item.localizedCaseInsensitiveContains(query)
        }
        return Array(matching.prefix(50))
    }

    private var incompleteTasks: [NativeTask] {
        tasks.filter { !$0.isComplete && !$0.item.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted(by: Self.taskOrder)
    }

    func start() {
        guard watcher == nil else { return }
        watcher = Task { [weak self, store, userID] in
            do {
                for try await rows in try await store.watch(table: "tasks") {
                    guard let self, !Task.isCancelled else { return }
                    tasks = Self.decode(rows, userID: userID)
                    error = nil
                }
            } catch is CancellationError {
            } catch {
                self?.error = error.localizedDescription
            }
        }
    }

    func stop() {
        watcher?.cancel()
        watcher = nil
        tasks = []
        searchQuery = ""
        error = nil
    }

    func refresh() async throws {
        tasks = Self.decode(try await store.readAll(table: "tasks"), userID: userID)
    }

    @discardableResult
    func add(_ item: String) async throws -> NativeTask {
        let text = item.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw NativeTasksError.emptyItem }
        let current = incompleteTasks
        let task = NativeTask(
            id: ChronologicalID.shared.next(), item: text,
            order: (current.map(\.order).min() ?? 1000) - (current.isEmpty ? 0 : 100),
            isComplete: false, defaultHash: nil, deletedAt: nil
        )
        try await store.write(table: "tasks", id: task.id, values: [
            "item": .text(task.item), "order": .integer(task.order), "is_complete": .integer(0),
            "default_hash": .null, "deleted_at": .null, "user_id": .text(userID),
        ])
        try await refresh()
        return task
    }

    func updateItem(id: String, item: String) async throws {
        let text = item.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { try await delete(id: id); return }
        guard tasks.contains(where: { $0.id == id && $0.deletedAt == nil }) else { throw NativeTasksError.missingTask }
        try await store.write(table: "tasks", id: id, values: ["item": .text(text)])
        try await refresh()
    }

    func setComplete(id: String, isComplete: Bool) async throws {
        guard tasks.contains(where: { $0.id == id && $0.deletedAt == nil }) else { throw NativeTasksError.missingTask }
        try await store.write(table: "tasks", id: id, values: ["is_complete": .integer(isComplete ? 1 : 0)])
        try await refresh()
    }

    /// Scrubs user content while retaining the owner key required by PowerSync.
    func delete(id: String, at date: Date = Date()) async throws {
        guard tasks.contains(where: { $0.id == id && $0.deletedAt == nil }) else { throw NativeTasksError.missingTask }
        try await store.write(table: "tasks", id: id, values: [
            "item": .null, "order": .null, "is_complete": .null, "default_hash": .null,
            "deleted_at": .text(ISO8601DateFormatter().string(from: date)),
        ])
        try await refresh()
    }

    func move(from source: Int, to destination: Int) async throws {
        let ordered = incompleteTasks
        guard ordered.indices.contains(source), ordered.indices.contains(destination) else {
            throw NativeTasksError.invalidMove
        }
        var moved = ordered
        let task = moved.remove(at: source)
        moved.insert(task, at: destination)
        let mutations = moved.enumerated().map { index, task in
            NativeSyncMutation(table: "tasks", id: task.id, values: ["order": .integer(Int64(index * 100))])
        }
        try await store.writeTransaction(mutations)
        try await refresh()
    }

    private static func decode(_ rows: [NativeSyncRow], userID: String) -> [NativeTask] {
        rows.compactMap { row in
            guard row.values["user_id"] == .text(userID) else { return nil }
            let item: String
            if case .text(let value)? = row.values["item"] { item = value } else { item = "" }
            let order: Int64
            if case .integer(let value)? = row.values["order"] { order = value } else { order = 0 }
            let isComplete = row.values["is_complete"] == .integer(1)
            let defaultHash = row.values["default_hash"]?.text
            let deletedAt = row.values["deleted_at"]?.text
            return NativeTask(id: row.id, item: item, order: order, isComplete: isComplete, defaultHash: defaultHash, deletedAt: deletedAt)
        }.sorted(by: Self.taskOrder)
    }

    private static func taskOrder(_ lhs: NativeTask, _ rhs: NativeTask) -> Bool {
        lhs.order == rhs.order ? lhs.id > rhs.id : lhs.order < rhs.order
    }
}
