/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class ConversationRecordsTests: XCTestCase {
    func testTauriPartsParentsAndUnknownMetadataSurviveRoundTrip() throws {
        let generator = ChronologicalID()
        let threadID = generator.next()
        let messageID = generator.next()
        let rawParts = #"[{"type":"text","text":"Hello"},{"type":"future-part","nested":{"value":42}}]"#
        let thread = NativeSyncRow(table: "chat_threads", id: threadID, values: [
            "title": .text("A chat"), "is_encrypted": .integer(1), "agent_id": .text("agent-id"),
            "project_id": .text("project-id"), "context_size": .integer(1000),
        ])
        let message = NativeSyncRow(table: "chat_messages", id: messageID, values: [
            "role": .text("assistant"), "parts": .text(rawParts), "chat_thread_id": .text(threadID),
            "parent_id": .text("parent-id"), "model_id": .text("model-id"),
            "metadata": .text(#"{"usage":{"totalTokens":42},"futureFlag":true}"#),
            "cache": .text(#"{"ask/abc":{"prompt":"Choose","selectedIds":["a"],"chosen":["Alpha"],"matched":null},"futureWidget":true}"#),
        ])
        let chat = try XCTUnwrap(ConversationRecords.decode(threads: [thread], messages: [message]).first)
        XCTAssertTrue(chat.isPrivate == true)
        XCTAssertEqual(chat.projectID, "project-id")
        XCTAssertEqual(chat.contextSize, 1000)
        XCTAssertEqual(ConversationRecords.thread(chat, userID: "user").values["context_size"], .integer(1000))
        XCTAssertEqual(chat.messages.first?.parentID, "parent-id")
        XCTAssertEqual(chat.modelID, "model-id")
        let encoded = try ConversationRecords.message(XCTUnwrap(chat.messages.first), threadID: threadID, userID: "user")
        let parts = try JSONDecoder().decode(ChatJSONValue.self, from: Data(XCTUnwrap(encoded.values["parts"]?.text).utf8))
        XCTAssertEqual(parts, try JSONDecoder().decode(ChatJSONValue.self, from: Data(rawParts.utf8)))
        XCTAssertEqual(encoded.values["parent_id"], .text("parent-id"))
        let cache = try JSONDecoder().decode(ChatJSONValue.self, from: Data(XCTUnwrap(encoded.values["cache"]?.text).utf8))
        XCTAssertEqual(cache, chat.messages.first?.cache)
        XCTAssertEqual(cache["futureWidget"], .bool(true))
    }

    func testMalformedJSONSurfacesInsteadOfSilentlyErasingParts() {
        let message = NativeSyncRow(table: "chat_messages", id: "id", values: [
            "role": .text("assistant"), "parts": .text("broken JSON"),
        ])
        XCTAssertThrowsError(try ConversationRecords.decodeMessage(message))
    }

    func testScrubbedTauriTombstonesNeverBecomeMalformedLiveMessages() throws {
        let id = ChronologicalID.shared.next()
        let thread = NativeSyncRow(table: "chat_threads", id: id, values: ["title": .text("Live")])
        let deleted = NativeSyncRow(table: "chat_messages", id: ChronologicalID.shared.next(), values: [
            "chat_thread_id": .text(id), "role": .null, "content": .null, "parts": .null,
            "deleted_at": .text("2026-11-11T12:00:00Z"),
        ])
        let decoded = try ConversationRecords.decode(threads: [thread], messages: [deleted])
        XCTAssertEqual(decoded.count, 1)
        XCTAssertTrue(decoded[0].messages.isEmpty)
        let message = ChatMessage(role: .assistant, text: "Private", deletedAt: Date())
        let row = try ConversationRecords.message(message, threadID: id, userID: "owner")
        XCTAssertEqual(row.values["content"], .null)
        XCTAssertEqual(row.values["role"], .null)
        XCTAssertEqual(row.values["cache"], .null)
        XCTAssertEqual(row.values["user_id"], .text("owner"))
        XCTAssertNotNil(row.values["deleted_at"]?.text)
    }

    func testPrototypeMigrationKeepsMessageOrderingSoftDeletesAndParentChain() throws {
        let first = ChatMessage(id: UUID().uuidString, role: .user, text: "Hi", createdAt: Date(timeIntervalSince1970: 100))
        let second = ChatMessage(id: UUID().uuidString, role: .assistant, text: "Hello", createdAt: Date(timeIntervalSince1970: 101), deletedAt: Date())
        let old = Conversation(id: UUID().uuidString, title: "old", messages: [first, second], modelID: "model")
        let migrated = try XCTUnwrap(ConversationRecords.migratePrototype([old]).first)
        XCTAssertNotNil(ChronologicalID.date(from: migrated.id))
        XCTAssertLessThan(migrated.messages[0].id, migrated.messages[1].id)
        XCTAssertEqual(migrated.messages[1].parentID, migrated.messages[0].id)
        XCTAssertEqual(migrated.messages[1].deletedAt, second.deletedAt)
        XCTAssertEqual(migrated.messages[0].modelID, "model")
    }
}
