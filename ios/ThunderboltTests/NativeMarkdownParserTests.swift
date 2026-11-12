/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class NativeMarkdownParserTests: XCTestCase {
    func testHeadingDoesNotConsumeFollowingParagraph() {
        XCTAssertEqual(NativeMarkdownParser.parse("### Heading\nText below"),
            [.heading(level: 3, text: "Heading"), .paragraph("Text below")])
    }
    func testParsesHeadingsParagraphsAndRules() {
        XCTAssertEqual(
            NativeMarkdownParser.parse("# Heading\n\nParagraph\n\n---"),
            [.heading(level: 1, text: "Heading"), .paragraph("Paragraph"), .thematicBreak]
        )
    }

    func testParsesUnorderedAndOrderedLists() {
        XCTAssertEqual(
            NativeMarkdownParser.parse("- first\n- second\n\n1. one\n2) two"),
            [.unorderedList(["first", "second"]), .orderedList(["one", "two"])]
        )
    }

    func testParsesBlockquotes() {
        XCTAssertEqual(
            NativeMarkdownParser.parse("> first line\n> **second line**"),
            [.quote("first line\n**second line**")]
        )
    }

    func testParsesTablesAndKeepsRows() {
        XCTAssertEqual(
            NativeMarkdownParser.parse("| Name | Count |\n| :--- | ---: |\n| Chat | 2 |\n| Model | 3 |"),
            [.table(headers: ["Name", "Count"], rows: [["Chat", "2"], ["Model", "3"]])]
        )
    }

    func testKeepsFencedCodeLiteralAndCapturesLanguage() {
        let fence = String(repeating: Character(UnicodeScalar(96)!), count: 3)
        XCTAssertEqual(
            NativeMarkdownParser.parse("Before\n\n\(fence)swift\nlet value = **literal**\n\(fence)\n\nAfter"),
            [
                .paragraph("Before"),
                .code(language: "swift", text: "let value = **literal**"),
                .paragraph("After"),
            ]
        )
    }

    func testAcceptsTildeAndUnclosedFences() {
        XCTAssertEqual(
            NativeMarkdownParser.parse("~~~json\n{\"ok\":true}"),
            [.code(language: "json", text: "{\"ok\":true}")]
        )
    }

    func testNormalizesLineEndingsAndPreservesParagraphNewlines() {
        XCTAssertEqual(
            NativeMarkdownParser.parse("first\r\nsecond\r\n\r\nthird"),
            [.paragraph("first\nsecond"), .paragraph("third")]
        )
    }

    func testResolvesReferenceLinksDefinedAfterTheirParagraphAndTable() {
        let document = NativeMarkdownParser.document("Read [Apple][guide].\n\n| Source |\n| --- |\n| [guide][] |\n\n[guide]: <https://apple.com/docs>\n  \"Documentation\"")
        XCTAssertEqual(document.blocks, [
            .paragraph("Read [Apple][guide]."),
            .table(headers: ["Source"], rows: [["[guide][]"]]),
        ])
        let paragraph = NativeMarkdownInline.attributed("Read [Apple][guide].", references: document.referenceDefinitions)
        XCTAssertEqual(String(paragraph.characters), "Read Apple.")
        XCTAssertEqual(paragraph.runs.compactMap(\.link), [URL(string: "https://apple.com/docs")!])
        let collapsed = NativeMarkdownInline.attributed("[GUIDE][]", references: document.referenceDefinitions)
        XCTAssertEqual(String(collapsed.characters), "GUIDE")
        XCTAssertEqual(collapsed.runs.first?.link, URL(string: "https://apple.com/docs"))
    }

    func testReferenceLookingCodeAndUnresolvedLinksRemainLiteral() {
        let document = NativeMarkdownParser.document("````md\n[a]: https://hidden.test\n```\n`````\n\n[missing][nope]\n\n[a]: https://apple.com")
        XCTAssertEqual(document.blocks, [.code(language: "md", text: "[a]: https://hidden.test\n```"), .paragraph("[missing][nope]")])
        let value = NativeMarkdownInline.attributed("`[a]` and [missing][nope]", references: document.referenceDefinitions)
        XCTAssertEqual(String(value.characters), "[a] and [missing][nope]")
        XCTAssertTrue(value.runs.compactMap(\.link).isEmpty)
    }
}
