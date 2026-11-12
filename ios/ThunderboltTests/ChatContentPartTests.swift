/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import XCTest
@testable import Thunderbolt

final class ChatContentPartTests: XCTestCase {
    func testUnknownPartsRoundTripWithoutDroppingFields() throws {
        let data = Data(#"[{"type":"text","text":"hello","state":"done"},{"type":"future-render","id":"future-1","value":{"count":2,"enabled":true}}]"#.utf8)
        let parts = try JSONDecoder().decode([ChatContentPart].self, from: data)
        let encoded = try JSONEncoder().encode(parts)
        let decodedAgain = try JSONDecoder().decode([ChatContentPart].self, from: encoded)

        XCTAssertEqual(parts, decodedAgain)
        XCTAssertEqual(parts[1].type, "future-render")
        XCTAssertEqual(parts[1].rawValue["value"]?["count"], .number(2))
        XCTAssertEqual(parts[1].id, "future-1")
    }

    func testMissingPartIDsAreDeterministicAndMessageAdapterUsesStableOffsets() throws {
        let data = Data(#"[{"type":"text","text":"same"},{"type":"text","text":"same"}]"#.utf8)
        let decodedOnce = try JSONDecoder().decode([ChatContentPart].self, from: data)
        let decodedTwice = try JSONDecoder().decode([ChatContentPart].self, from: data)
        let document = ChatMessageContent(partsData: data)

        XCTAssertEqual(decodedOnce.map(\.id), decodedTwice.map(\.id))
        XCTAssertEqual(document.parts.map(\.id), ["part-0", "part-1"])
        XCTAssertNotEqual(document.parts[0].id, document.parts[1].id)
    }

    func testTypedAndDynamicToolNamesAreRecovered() throws {
        let data = Data(#"[{"type":"tool-render_html","toolCallId":"call-1","state":"input-available","input":{"html":"<h1>Hi</h1>","title":"Report"}},{"type":"dynamic-tool","toolName":"search_web","toolCallId":"call-2","state":"output-available"}]"#.utf8)
        let parts = try JSONDecoder().decode([ChatContentPart].self, from: data)

        XCTAssertEqual(parts[0].toolName, "render_html")
        XCTAssertEqual(parts[0].artifactTitle, "Report")
        XCTAssertEqual(parts[0].artifactHTML, "<h1>Hi</h1>")
        XCTAssertEqual(parts[1].toolName, "search_web")
        XCTAssertTrue(parts[0].isTool)
        XCTAssertTrue(parts[1].isTool)
    }

    func testRenderHTMLRequiresSuccessfulVerificationOutput() throws {
        let verified = try decodePart(#"{"type":"tool-render_html","state":"output-available","input":{"html":"<p>safe</p>"},"output":{"ok":true}}"#)
        let failed = try decodePart(#"{"type":"tool-render_html","state":"output-available","input":{"html":"<p>unsafe</p>"},"output":{"ok":false,"errors":["blocked"]}}"#)
        let wrapped = try decodePart(#"{"type":"dynamic-tool","toolName":"render_html","state":"output-available","input":{"html":"<p>wrapped</p>"},"output":{"content":[{"type":"text","text":"{\"ok\":true}"}]}}"#)

        XCTAssertTrue(verified.hasVerifiedArtifactOutput)
        XCTAssertFalse(failed.hasVerifiedArtifactOutput)
        XCTAssertTrue(wrapped.hasVerifiedArtifactOutput)
    }

    func testTauriMetadataSourcesAndDocumentReferencesDecode() {
        let metadata = ChatJSONValue.object([
            "modelId": .string("model-a"),
            "sources": .array([
                .object([
                    "index": .number(1),
                    "title": .string("Example"),
                    "url": .string("https://example.com"),
                    "siteName": .string("Example"),
                ]),
            ]),
            "haystackReferences": .array([
                .object([
                    "position": .number(2),
                    "fileId": .string("file-1"),
                    "fileName": .string("guide.pdf"),
                    "pageNumber": .number(4),
                ]),
            ]),
            "mcpTools": .object([
                "search_web": .object([
                    "name": .string("Search server"),
                    "url": .string("https://tools.example"),
                    "toolName": .string("Web Search"),
                ]),
            ]),
        ])
        let content = ChatContentMetadata(rawValue: metadata)

        XCTAssertEqual(content.modelID, "model-a")
        XCTAssertEqual(content.sources.first?.siteName, "Example")
        XCTAssertEqual(content.sources.first?.url, "https://example.com")
        XCTAssertEqual(content.haystackReferences.first?.fileName, "guide.pdf")
        XCTAssertEqual(content.haystackReferences.first?.pageNumber, 4)
        XCTAssertEqual(content.mcpTools["search_web"]?.toolName, "Web Search")
    }

    func testLegacyTextIsUsedWhenPartsAreMissingOrUnreadable() {
        let missing = ChatMessageContent(partsData: nil, legacyText: "older message")
        let unreadable = ChatMessageContent(partsData: Data("not-json".utf8), legacyText: "fallback")

        XCTAssertEqual(missing.parts.first?.text, "older message")
        XCTAssertEqual(unreadable.parts.first?.text, "fallback")
    }

    func testMessageAdapterUsesPartsBeforeLegacyText() {
        let part = ChatContentPart(
            rawValue: .object(["type": .string("text"), "text": .string("part text")]),
            fallbackID: "ignored"
        )
        let message = ChatMessage(id: "message-1", role: .assistant, text: "legacy text", parts: [part])
        let content = ChatMessageContent(message: message)

        XCTAssertEqual(content.parts.map(\.text), ["part text"])
    }

    private func decodePart(_ json: String) throws -> ChatContentPart {
        let data = Data("[\(json)]".utf8)
        return try XCTUnwrap(JSONDecoder().decode([ChatContentPart].self, from: data).first)
    }
}
