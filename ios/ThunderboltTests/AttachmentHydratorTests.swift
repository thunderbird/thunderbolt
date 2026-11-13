/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class AttachmentHydratorTests: XCTestCase {
    func testOnlyCurrentTurnIncludesImageBytesAndMissingFilesProduceANote() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = AttachmentStore(directory: folder)
        let bytes = Data([0x89, 0x50, 0x4e, 0x47])
        let image = try await store.store(bytes, filename: "diagram.png", mimeType: "image/png", owner: "alice")
        let message = ChatMessage(role: .user, text: "", parts: [image.part])
        let current = try await AttachmentHydrator.parts(for: message, isCurrentTurn: true, owner: "alice", store: store)
        let previous = try await AttachmentHydrator.parts(for: message, isCurrentTurn: false, owner: "alice", store: store)
        let unavailable = try await AttachmentHydrator.parts(for: message, isCurrentTurn: true, owner: "bob", store: store)
        XCTAssertEqual(current.filter { $0.type == "file" }.count, 1)
        XCTAssertFalse(previous.contains { $0.type == "file" })
        XCTAssertTrue(previous.contains { $0.text == "[Attachment: diagram.png]" })
        XCTAssertTrue(unavailable.contains { $0.text?.contains("not available on this device") == true })
        XCTAssertEqual(AttachmentHydrator.anthropicContent(current).arrayValue?.first?["source"]?["data"], .string(bytes.base64EncodedString()))
        XCTAssertEqual(AttachmentHydrator.openAIContent(current).arrayValue?.first?["type"], .string("image_url"))
        XCTAssertEqual(message.parts, [image.part], "Hydration must never replace persisted references with bytes")
    }

    func testTextFileIsDeliveredAsTextAndUnknownPartsSurviveHostedReplay() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = AttachmentStore(directory: folder)
        let file = try await store.store(Data("a,b\n1,2".utf8), filename: "report.csv", mimeType: nil, owner: "alice")
        let unknown = ChatContentPart(rawValue: .object(["type": .string("data-future"), "data": .object(["x": .number(1)])]), fallbackID: "future")
        let message = ChatMessage(role: .user, text: "", parts: [file.part, unknown])
        let hydrated = try await AttachmentHydrator.parts(for: message, isCurrentTurn: true, owner: "alice", store: store)
        XCTAssertTrue(hydrated.contains { $0.rawValue == unknown.rawValue })
        XCTAssertEqual(AttachmentHydrator.openAIContent(hydrated), .string("[Attachment: report.csv]\n\na,b\n1,2"))
        XCTAssertFalse(hydrated.contains { $0.type == "file" })
    }
}
