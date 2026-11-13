/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
import PowerSync
@testable import Thunderbolt

final class NativeAgentsLibraryTests: XCTestCase {
    @MainActor
    func testCustomAgentCRUDSoftDeletesAndKeepsCredentialsLocal() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: AgentTestCodec(), trustedDevice: { true })
        let library = NativeAgentsLibrary(store: store, userID: "user-1")

        let id = try await library.add(name: "Remote", url: "wss://agent.example/ws", description: "Test")
        try await library.saveSecrets(NativeACPAgentSecrets(apiKey: "private-key", authMethod: "header"), for: id)
        try await library.refresh()
        XCTAssertEqual(library.agents.map(\.id), [id])
        XCTAssertEqual(library.agents.first?.type, .remote)
        let savedSecrets = try await library.secrets(for: id)
        XCTAssertEqual(savedSecrets?.apiKey, "private-key")
        let localSecret = try await store.read(table: "agents_secrets", id: id)
        XCTAssertEqual(localSecret?.values["api_key"], .text("private-key"))

        try await library.update(id, name: "Managed", url: "wss://agent.example/v2", description: nil, type: .managed)
        try await library.refresh()
        XCTAssertEqual(library.agents.first?.name, "Managed")
        XCTAssertEqual(library.agents.first?.type, .managed)

        try await library.setEnabled(false, id: id)
        try await library.refresh()
        XCTAssertEqual(library.agents.first?.enabled, false)
        try await library.delete(id)
        try await library.refresh()
        XCTAssertTrue(library.agents.isEmpty)
        let tombstone = try await store.read(table: "agents", id: id)
        XCTAssertNotNil(tombstone?.values["deleted_at"]?.text)
        let retainedSecrets = try await library.secrets(for: id)
        XCTAssertEqual(retainedSecrets?.apiKey, "private-key")
    }

    @MainActor
    func testAgentURLRequiresSecureWebSocketAndRejectsCredentialsInURL() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: AgentTestCodec(), trustedDevice: { true })
        let library = NativeAgentsLibrary(store: store, userID: "user-1")
        for invalid in ["ws://agent.example/ws", "https://agent.example", "wss://name:secret@agent.example/ws", "not-a-url"] {
            do {
                _ = try await library.add(name: "Invalid", url: invalid)
                XCTFail("Expected URL rejection for \(invalid)")
            } catch let error as NativeAgentsError {
                XCTAssertEqual(error, .invalidWebSocketURL)
            }
        }
        let rows = try await store.readAll(table: "agents")
        XCTAssertTrue(rows.isEmpty)
    }
}

private struct AgentTestCodec: NativeSyncRowCodec {
    func isEncryptionConfigured() async throws -> Bool { true }
    func isReadyForSync() async throws -> Bool { true }
    func encode(_ plaintext: String, context: E2EEContext) async throws -> String { "__enc:v2:\(plaintext)" }
    func decode(_ encoded: String, context: E2EEContext?) async throws -> String { String(encoded.dropFirst("__enc:v2:".count)) }
    func isEncryptedValue(_ value: String) -> Bool { value.hasPrefix("__enc:") }
    func isValidV2Ciphertext(_ value: String) -> Bool { value.hasPrefix("__enc:v2:") }
}
