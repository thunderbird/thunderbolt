/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

@MainActor
final class OfflineAccountTests: XCTestCase {
    func testLocalUnlockCanDecryptButCannotAuthorizeSync() async throws {
        let server = "https://server.test/v1"
        let vault = DeviceVault(service: "thunderbolt.offline.test.\(UUID())")
        defer { try? vault.remove(server: server, userID: "user") }
        let dataKey = Data(repeating: 42, count: 32)
        let record = NativeDeviceRecord(id: "device", keys: try ThunderboltCrypto.generateDeviceKeys(),
            accountKey: Data(repeating: 7, count: 32), dataKeys: ["0": dataKey], keyVersion: 1, primaryKeyID: "0")
        try vault.save(record, server: server, userID: "user")
        let coordinator = DeviceCoordinator(vault: vault)
        let unlocked = try await coordinator.unlockLocal(server: server, userID: "user")
        XCTAssertTrue(unlocked)
        XCTAssertEqual(coordinator.state, .offline)
        let keys = coordinator.dataKeys
        let trusted = await keys.isTrusted()
        XCTAssertFalse(trusted)
        let codec = ThunderboltColumnCodec(keys: keys)
        let wire = "__enc:v2:0:AAECAwQFBgcICQoL:JUMgLe5MU1vsUmSCvtXx+g2M+/ftbss1CKylZPTQtmjNO0cI2gd0Psi7LLD2bg=="
        let opened = try await codec.decode(wire, context: E2EEContext(table: "chat_messages", column: "content", rowID: "msg_123"))
        XCTAssertEqual(opened, "interoperability fixture café")
        let store = NativeSyncStore.open(ownerID: "user", codec: codec, trustedDevice: { await keys.isTrusted() }, dbFilename: ":memory:")
        let readiness = await store.readiness
        XCTAssertEqual(readiness, .waitingForTrustedDevice)
        await coordinator.suspend()
        let configured = await keys.isEncryptionConfigured()
        XCTAssertFalse(configured)
    }

    func testAnIncompleteKeyringCannotUnlockOffline() async throws {
        let server = "https://server.test/v1"
        let vault = DeviceVault(service: "thunderbolt.offline.test.\(UUID())")
        defer { try? vault.remove(server: server, userID: "user") }
        let record = NativeDeviceRecord(id: "device", keys: try ThunderboltCrypto.generateDeviceKeys(),
            accountKey: Data(repeating: 7, count: 32), dataKeys: [:], keyVersion: 1, primaryKeyID: "0")
        try vault.save(record, server: server, userID: "user")
        let coordinator = DeviceCoordinator(vault: vault)
        let unlocked = try await coordinator.unlockLocal(server: server, userID: "user")
        XCTAssertFalse(unlocked)
        XCTAssertNil(coordinator.record)
    }
}
