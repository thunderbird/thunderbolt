/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

@MainActor
final class ProjectLibraryTests: XCTestCase {
    func testDeletingProjectKeepsChatsAndScrubsProjectContent() async throws {
        let keys = DeviceDataKeys()
        try await keys.publish(["0": Data(repeating: 9, count: 32)], primary: "0")
        let store = NativeSyncStore.open(ownerID: "user", codec: ThunderboltColumnCodec(keys: keys),
            trustedDevice: { await keys.isTrusted() }, dbFilename: ":memory:")
        let library = ProjectLibrary(store: store, userID: "user")
        let project = NativeProject(name: "Research", instructions: "Private project instructions", icon: "🔎")
        try await library.save(project)
        let threadID = ChronologicalID.shared.next()
        try await store.write(table: "chat_threads", id: threadID, values: [
            "user_id": .text("user"), "title": .text("Keep this chat"), "project_id": .text(project.id),
        ])
        try await library.delete(project)
        let chat = try await store.read(table: "chat_threads", id: threadID)
        XCTAssertEqual(chat?.values["title"], .text("Keep this chat"))
        XCTAssertEqual(chat?.values["project_id"], .null)
        XCTAssertNil(chat?.values["deleted_at"]?.text)
        let tombstone = try await store.read(table: "projects", id: project.id)
        XCTAssertEqual(tombstone?.values["name"], .null)
        XCTAssertEqual(tombstone?.values["instructions"], .null)
        XCTAssertNotNil(tombstone?.values["deleted_at"]?.text)
    }

    func testEditingInstructionsDoesNotResetAConcurrentPin() async throws {
        let keys = DeviceDataKeys()
        try await keys.publish(["0": Data(repeating: 10, count: 32)], primary: "0")
        let store = NativeSyncStore.open(ownerID: "user", codec: ThunderboltColumnCodec(keys: keys),
            trustedDevice: { await keys.isTrusted() }, dbFilename: ":memory:")
        let library = ProjectLibrary(store: store, userID: "user")
        var project = NativeProject(name: "Project")
        try await library.save(project)
        try await store.write(table: "projects", id: project.id, values: ["user_id": .text("user"), "pinned_order": .integer(3)])
        project.instructions = "Updated instructions"
        try await library.save(project)
        let row = try await store.read(table: "projects", id: project.id)
        XCTAssertEqual(row?.values["pinned_order"], .integer(3))
        XCTAssertEqual(row?.values["instructions"], .text("Updated instructions"))
    }
}
