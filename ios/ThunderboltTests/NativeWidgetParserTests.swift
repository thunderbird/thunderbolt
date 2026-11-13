/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class NativeWidgetParserTests: XCTestCase {
    func testPreservesTextOrderAndParsesKnownWidgets() {
        let parts = NativeWidgetParser.parse("Before <widget:link-preview url=\"https://example.com\" /> after")

        XCTAssertEqual(parts.count, 3)
        guard case .text(_, let before) = parts[0], case .widget(let widget) = parts[1], case .text(_, let after) = parts[2] else {
            return XCTFail("Expected text, widget, text")
        }
        XCTAssertEqual(before, "Before")
        XCTAssertEqual(widget.name, "link-preview")
        XCTAssertEqual(widget.arguments["url"], "https://example.com")
        XCTAssertEqual(after, "after")
    }

    func testSingleQuotedJSONMayContainApostrophesAndEscapedQuotes() {
        let parts = NativeWidgetParser.parse(#"<widget:ask prompt="NASA's mission" mode="choice" options='[{"id":"one","text":"NASA's Voyager"},{"id":"two","text":"Other"}]' />"#)

        guard let first = try? XCTUnwrap(parts.first), case .widget(let widget) = first else { return XCTFail("Expected ask widget") }
        XCTAssertEqual(widget.arguments["prompt"], "NASA's mission")
        XCTAssertEqual(widget.arguments["mode"], "choice")
        XCTAssertNotNil(widget.arguments["options"])
    }

    func testUnknownWidgetTagIsRemovedButAdjacentTextRemains() {
        let parts = NativeWidgetParser.parse("A <widget:future-card value=\"x\" /> B")
        let text = parts.compactMap { part -> String? in
            guard case .text(_, let value) = part else { return nil }
            return value
        }
        XCTAssertEqual(text, ["A", "B"])
    }

    func testMalformedIncompleteTagRemainsLiteralText() {
        let parts = NativeWidgetParser.parse("answer <widget:ask prompt=\"incomplete\"")
        XCTAssertEqual(parts.count, 1)
        guard case .text(_, let value) = parts[0] else { return XCTFail("Expected literal text") }
        XCTAssertEqual(value, "answer")
    }
}
