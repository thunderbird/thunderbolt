/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

@MainActor
final class SyncedConversationStoreTests: XCTestCase {
    func testUndisplayedRemoteTitleIsNotOverwrittenByAMessageSave() async throws {
        let keys = DeviceDataKeys()
        try await keys.publish(["0": Data(repeating: 7, count: 32)], primary: "0")
        let store = NativeSyncStore.open(ownerID: "user", codec: ThunderboltColumnCodec(keys: keys),
            trustedDevice: { await keys.isTrusted() }, dbFilename: ":memory:")
        let repository = SyncedConversationStore(store: store, owner: "server|user", userID: "user")
        let chat = Conversation(title: "Original", messages: [ChatMessage(role: .assistant, text: "Partial")])
        try await repository.save([chat], owner: "server|user")
        var displayed = try await repository.load(owner: "server|user")
        try await store.write(table: "chat_threads", id: chat.id, values: ["user_id": .text("user"), "title": .text("Remote title")])
        let pendingRemote = try await repository.snapshot(owner: "server|user")
        XCTAssertEqual(pendingRemote.first?.title, "Remote title")
        displayed[0].messages[0].text = "Completed local response"
        try await repository.save(displayed, owner: "server|user")
        let result = try await repository.load(owner: "server|user")
        XCTAssertEqual(result.first?.title, "Remote title")
        XCTAssertEqual(result.first?.messages.first?.text, "Completed local response")
    }

    func testRepeatedSavesCommitInInvocationOrder() async throws {
        let keys = DeviceDataKeys()
        try await keys.publish(["0": Data(repeating: 8, count: 32)], primary: "0")
        let store = NativeSyncStore.open(ownerID: "user", codec: ThunderboltColumnCodec(keys: keys),
            trustedDevice: { await keys.isTrusted() }, dbFilename: ":memory:")
        let repository = SyncedConversationStore(store: store, owner: "server|user", userID: "user")
        let original = Conversation(title: "Original")
        try await repository.save([original], owner: "server|user")
        var first = original
        first.title = "First rename"
        var last = original
        last.title = "Last rename"
        let firstSave = Task { try await repository.save([first], owner: "server|user") }
        await Task.yield()
        let lastSave = Task { try await repository.save([last], owner: "server|user") }
        try await firstSave.value
        try await lastSave.value
        let result = try await repository.load(owner: "server|user")
        XCTAssertEqual(result.first?.title, "Last rename")
    }
}
