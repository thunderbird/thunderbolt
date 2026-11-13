// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import XCTest
import PowerSync
@testable import Thunderbolt

final class NativeSyncStoreTests: XCTestCase {
    func testSchemaMirrorsTheSharedRegistryAndTracksLocalOnlyTables() {
        XCTAssertEqual(
            NativePowerSyncSchema.synchronizedTables.map(\.name),
            ["settings", "chat_threads", "chat_messages", "tasks", "models", "provider_connections", "prompts", "skills", "triggers", "model_profiles", "devices", "agents", "projects"]
        )
        XCTAssertEqual(
            NativePowerSyncSchema.localOnlyTables.map(\.name),
            ["provider_connection_secrets", "models_secrets", "integrations_secrets", "mcp_servers", "mcp_secrets", "agents_system", "agents_secrets"]
        )
        XCTAssertTrue(NativePowerSyncSchema.byName["models"]?.encryptedColumns.contains("provider_connection_id") == true)
        XCTAssertTrue(NativePowerSyncSchema.byName["provider_connections"]?.trackMetadata == true)
        XCTAssertFalse(NativePowerSyncSchema.byName["mcp_servers"]?.trackMetadata ?? true)
    }

    func testPowerSyncManagedViewStoresWireCiphertextAndReturnsPlaintext() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(), trustedDevice: { true })
        let threadID = "thread-1"
        let messageID = "message-1"

        try await store.writeTransaction([
            NativeSyncMutation(table: "chat_threads", id: threadID, values: [
                "title": .text("Private title"),
                "user_id": .text("user-1"),
            ]),
            NativeSyncMutation(table: "chat_messages", id: messageID, values: [
                "content": .text("Private message"),
                "role": .text("user"),
                "chat_thread_id": .text(threadID),
                "user_id": .text("user-1"),
            ]),
        ])

        let rawTitle = try await database.getOptional(
            sql: "SELECT title FROM chat_threads WHERE id = ?", parameters: [threadID]
        ) { $0.getStringOptional(index: 0) }
        XCTAssertEqual(rawTitle, "__enc:v2:Private title")
        let thread = try await store.read(table: "chat_threads", id: threadID)
        let message = try await store.read(table: "chat_messages", id: messageID)
        XCTAssertEqual(thread?.values["title"], .text("Private title"))
        XCTAssertEqual(message?.values["content"], .text("Private message"))
    }

    func testEncryptedWritesRequireCodecAndWritesAreScopedToOwner() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: nil, trustedDevice: { false })
        do {
            try await store.write(table: "chat_threads", id: "thread", values: [
                "title": .text("must not be persisted as plaintext"),
                "user_id": .text("user-1"),
            ])
            XCTFail("Expected an unavailable encryption codec to reject encrypted-column writes")
        } catch let error as NativeSyncStoreError {
            XCTAssertEqual(error, .encryptionUnavailable(table: "chat_threads", column: "title"))
        }
        let absent = try await database.getOptional(
            sql: "SELECT id FROM chat_threads WHERE id = ?", parameters: ["thread"]
        ) { $0.getStringOptional(index: 0) }
        XCTAssertNil(absent)

        let unreadyStore = NativeSyncStore(
            database: database,
            ownerID: "user-1",
            codec: TestRowCodec(configured: false),
            trustedDevice: { true }
        )
        do {
            try await unreadyStore.write(table: "chat_threads", id: "thread", values: [
                "title": .text("codec would pass through plaintext"),
                "user_id": .text("user-1"),
            ])
            XCTFail("An unready codec must not persist encrypted columns")
        } catch let error as NativeSyncStoreError {
            XCTAssertEqual(error, .encryptionUnavailable(table: "chat_threads", column: "title"))
        }
        let stillAbsent = try await database.getOptional(
            sql: "SELECT id FROM chat_threads WHERE id = ?", parameters: ["thread"]
        ) { $0.getStringOptional(index: 0) }
        XCTAssertNil(stillAbsent)

        let wrongOwner = NativeSyncStore(database: database, ownerID: "user-2", codec: TestRowCodec(), trustedDevice: { true })
        do {
            try await wrongOwner.write(table: "chat_threads", id: "thread", values: [
                "title": .text("not mine"),
                "user_id": .text("user-1"),
            ])
            XCTFail("Expected owner mismatch to reject the row")
        } catch let error as NativeSyncStoreError {
            XCTAssertEqual(error, .ownerMismatch)
        }
    }

    func testReadinessRequiresTrustedDeviceAndInitializedCodec() async {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let waitingForTrust = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(), trustedDevice: { false })
        let trustReadiness = await waitingForTrust.readiness
        XCTAssertEqual(trustReadiness, .waitingForTrustedDevice)
        let waitingForKeys = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(configured: false), trustedDevice: { true })
        let keyReadiness = await waitingForKeys.readiness
        XCTAssertEqual(keyReadiness, .waitingForCodec)
    }

    func testStatusWatchStartsWithLiveSDKSnapshotAndReportsInitialSyncState() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(), trustedDevice: { true })

        let current = await store.syncStatusSnapshot()
        XCTAssertEqual(current.initialSyncCompleted, current.hasSynced == true)

        var updates = await store.watchSyncStatus().makeAsyncIterator()
        let first = await updates.next()
        XCTAssertNotNil(first)
        XCTAssertEqual(first?.initialSyncCompleted, first?.hasSynced == true)
    }

    func testDownloadBoundaryRejectsPlaintextInConfiguredEncryptedColumn() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(), trustedDevice: { true })
        try await database.execute(
            sql: "INSERT INTO chat_threads (id, title, user_id) VALUES (?, ?, ?)",
            parameters: ["injected", "untrusted plaintext", "user-1"]
        )

        do {
            _ = try await store.read(table: "chat_threads", id: "injected")
            XCTFail("Plaintext from an encrypted column must never reach a caller")
        } catch let error as NativeSyncStoreError {
            XCTAssertEqual(error, .plaintextOnEncryptedColumn(table: "chat_threads", column: "title"))
        }
    }

    func testUploadRejectsPlaintextAndHardDeletes() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(), trustedDevice: { true })
        let plaintext = NativeSyncOperation(op: "PATCH", type: "chat_threads", id: "thread-1", data: ["title": .string("not ciphertext")])
        do {
            try await store.validateForUpload(plaintext)
            XCTFail("An encrypted column must never be uploaded as plaintext")
        } catch let error as NativeSyncStoreError {
            XCTAssertEqual(error, .plaintextOnEncryptedColumn(table: "chat_threads", column: "title"))
        }

        let deletion = NativeSyncOperation(op: "DELETE", type: "chat_threads", id: "thread-1", data: nil)
        do {
            try await store.validateForUpload(deletion)
            XCTFail("Synced data uses soft deletes; hard deletes require an explicit account route")
        } catch let error as NativeSyncStoreError {
            XCTAssertEqual(error, .hardDeleteUnsupported("chat_threads"))
        }
    }
}

private struct TestRowCodec: NativeSyncRowCodec {
    var configured = true

    func isEncryptionConfigured() async throws -> Bool { configured }
    func isReadyForSync() async throws -> Bool { configured }
    func encode(_ plaintext: String, context: E2EEContext) async throws -> String { "__enc:v2:\(plaintext)" }
    func decode(_ encoded: String, context: E2EEContext?) async throws -> String { String(encoded.dropFirst("__enc:v2:".count)) }
    func isEncryptedValue(_ value: String) -> Bool { value.hasPrefix("__enc:") }
    func isValidV2Ciphertext(_ value: String) -> Bool { value.hasPrefix("__enc:v2:") }
}
