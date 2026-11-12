/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import PowerSync
import XCTest
@testable import Thunderbolt

@MainActor
final class TasksLibraryTests: XCTestCase {
    func testTaskContentIsEncryptedAndOrderingMatchesSharedTableContract() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-a", codec: TasksTestCodec(), trustedDevice: { true })
        let library = TasksLibrary(store: store, userID: "user-a")
        try await store.writeTransaction([
            .init(table: "tasks", id: "task-a", values: ["item": .text("Later"), "order": .integer(100), "is_complete": .integer(0), "user_id": .text("user-a")]),
            .init(table: "tasks", id: "task-b", values: ["item": .text("Earlier"), "order": .integer(0), "is_complete": .integer(0), "user_id": .text("user-a")]),
            .init(table: "tasks", id: "task-done", values: ["item": .text("Done"), "order": .integer(-10), "is_complete": .integer(1), "user_id": .text("user-a")]),
        ])

        try await library.refresh()

        XCTAssertEqual(library.visibleTasks.map(\.item), ["Earlier", "Later"])
        XCTAssertEqual(library.incompleteCount, 2)
        let rawItem = try await database.getOptional(
            sql: "SELECT item FROM tasks WHERE id = ?", parameters: ["task-a"]
        ) { $0.getStringOptional(index: 0) }
        XCTAssertEqual(rawItem, "__enc:v2:Later")
    }

    func testAddEditCompleteAndSoftDeletePreserveUserAndScrubTaskText() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-a", codec: TasksTestCodec(), trustedDevice: { true })
        let library = TasksLibrary(store: store, userID: "user-a")
        let added = try await library.add("Buy oat milk")
        try await library.updateItem(id: added.id, item: "Buy almond milk")
        XCTAssertEqual(library.visibleTasks.first?.item, "Buy almond milk")

        try await library.setComplete(id: added.id, isComplete: true)
        XCTAssertTrue(library.visibleTasks.isEmpty)
        XCTAssertEqual(library.incompleteCount, 0)

        try await library.setComplete(id: added.id, isComplete: false)
        try await library.delete(id: added.id)
        let raw = try await database.getOptional(
            sql: "SELECT item, user_id, deleted_at FROM tasks WHERE id = ?", parameters: [added.id]
        ) { cursor in
            (cursor.getStringOptional(index: 0), cursor.getStringOptional(index: 1), cursor.getStringOptional(index: 2))
        }
        XCTAssertNil(raw?.0)
        XCTAssertEqual(raw?.1, "user-a")
        XCTAssertNotNil(raw?.2)
        XCTAssertTrue(library.visibleTasks.isEmpty)
    }

    func testMovePersistsNewOrderAndSearchFiltersIncompleteRows() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-a", codec: TasksTestCodec(), trustedDevice: { true })
        let library = TasksLibrary(store: store, userID: "user-a")
        try await store.writeTransaction([
            .init(table: "tasks", id: "a", values: ["item": .text("Alpha"), "order": .integer(0), "is_complete": .integer(0), "user_id": .text("user-a")]),
            .init(table: "tasks", id: "b", values: ["item": .text("Beta"), "order": .integer(100), "is_complete": .integer(0), "user_id": .text("user-a")]),
            .init(table: "tasks", id: "c", values: ["item": .text("Completed Beta"), "order": .integer(200), "is_complete": .integer(1), "user_id": .text("user-a")]),
        ])
        try await library.refresh()

        try await library.move(from: 0, to: 1)
        XCTAssertEqual(library.visibleTasks.map(\.item), ["Beta", "Alpha"])
        library.searchQuery = "alpha"
        XCTAssertEqual(library.visibleTasks.map(\.item), ["Alpha"])
        XCTAssertEqual(library.incompleteCount, 2)
    }

    func testBlankTaskIsRejectedAndBlankEditUsesSoftDelete() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-a", codec: TasksTestCodec(), trustedDevice: { true })
        let library = TasksLibrary(store: store, userID: "user-a")

        do {
            _ = try await library.add("  \n ")
            XCTFail("Empty tasks are not stored.")
        } catch let error as NativeTasksError {
            XCTAssertEqual(error, .emptyItem)
        }
        let task = try await library.add("Keep or delete")
        try await library.updateItem(id: task.id, item: "  ")
        XCTAssertTrue(library.visibleTasks.isEmpty)
        let deletedAt = try await database.getOptional(
            sql: "SELECT deleted_at FROM tasks WHERE id = ?", parameters: [task.id]
        ) { $0.getStringOptional(index: 0) }
        XCTAssertNotNil(deletedAt)
    }
}

private struct TasksTestCodec: NativeSyncRowCodec {
    func isEncryptionConfigured() async throws -> Bool { true }
    func isReadyForSync() async throws -> Bool { true }
    func encode(_ plaintext: String, context: E2EEContext) async throws -> String { "__enc:v2:\(plaintext)" }
    func decode(_ encoded: String, context: E2EEContext?) async throws -> String {
        String(encoded.dropFirst("__enc:v2:".count))
    }
    func isEncryptedValue(_ value: String) -> Bool { value.hasPrefix("__enc:") }
    func isValidV2Ciphertext(_ value: String) -> Bool { value.hasPrefix("__enc:v2:") }
}
