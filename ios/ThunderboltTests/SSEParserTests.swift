/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import XCTest
@testable import Thunderbolt

final class SSEParserTests: XCTestCase {
    func testParsesMultipleFramesAndMultiLineDataAcrossChunks() {
        var parser = SSEParser()
        XCTAssertTrue(parser.append(Data("event: message\r\ndata: first\r".utf8)).isEmpty)
        let frames = parser.append(Data("\ndata: second\r\n\r\ndata: [DONE]\n\n".utf8))

        XCTAssertEqual(frames, [
            SSEFrame(event: "message", data: "first\nsecond", id: nil),
            SSEFrame(event: nil, data: "[DONE]", id: nil),
        ])
        XCTAssertTrue(parser.finish().isEmpty)
    }

    func testIgnoresCommentsAndParsesEventIDAndUTF8Text() {
        var parser = SSEParser()
        let frames = parser.append(Data(": keep-alive\nevent: text\nid: 7\ndata: café\n\n".utf8))

        XCTAssertEqual(frames, [SSEFrame(event: "text", data: "café", id: "7")])
    }

    func testFinishesAnEventBufferedWithoutFinalBlankLine() {
        var parser = SSEParser()
        XCTAssertTrue(parser.append(Data("data: final chunk".utf8)).isEmpty)

        XCTAssertEqual(parser.finish(), [SSEFrame(event: nil, data: "final chunk", id: nil)])
    }
}
