/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

@MainActor
final class PersistenceTests: XCTestCase {
    func testHistoryRoundTripAndAccountIsolation() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let storage = FileConversationStore(directory: folder)
        let chat = Conversation(title: "Hello", deletedAt: Date(), messages: [ChatMessage(role: .user, text: "你好 🌤")])
        try storage.save([chat], owner: "https://one.test|user-1")
        XCTAssertEqual(try storage.load(owner: "https://one.test|user-1"), [chat])
        XCTAssertEqual(try storage.load(owner: "https://one.test|user-2"), [])
        XCTAssertEqual(try storage.load(owner: "https://two.test|user-1"), [])
    }

    func testServerAddressRequiresSecureUnambiguousDestination() throws {
        XCTAssertEqual(try ServerAddress.normalize(" https://example.test/api/ ").absoluteString, "https://example.test/api/v1")
        XCTAssertEqual(try ServerAddress.normalize("http://localhost:18080/v1/").absoluteString, "http://localhost:18080/v1")
        for value in ["http://remote.test", "https://user:pass@example.test", "https://example.test?token=secret", "https://example.test/#fragment", "file:///tmp/server"] {
            XCTAssertThrowsError(try ServerAddress.normalize(value), value)
        }
    }
}
