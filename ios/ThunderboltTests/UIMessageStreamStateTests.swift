/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class UIMessageStreamStateTests: XCTestCase {
    func testReasoningToolsAndTextKeepOrderAndMergeMetadata() throws {
        var state = UIMessageStreamState()
        let events = [
            #"{"type":"reasoning-start","id":"r1"}"#,
            #"{"type":"reasoning-delta","id":"r1","delta":"Checking"}"#,
            #"{"type":"reasoning-end","id":"r1"}"#,
            #"{"type":"tool-input-start","toolCallId":"t1","toolName":"search"}"#,
            #"{"type":"tool-input-available","toolCallId":"t1","toolName":"search","input":{"query":"test"}}"#,
            #"{"type":"tool-output-available","toolCallId":"t1","output":{"found":true}}"#,
            #"{"type":"text-start","id":"a1"}"#,
            #"{"type":"text-delta","id":"a1","delta":"Hello 日本語"}"#,
            #"{"type":"message-metadata","messageMetadata":{"reasoningTime":{"r1":2},"modelId":"model"}}"#,
            #"{"type":"message-metadata","messageMetadata":{"reasoningTime":{"t1":3}}}"#,
        ]
        for event in events { XCTAssertFalse(try state.consume(event)) }
        XCTAssertEqual(state.parts.map(\.type), ["reasoning", "tool-search", "text"])
        XCTAssertEqual(state.parts[1].state, "output-available")
        XCTAssertEqual(state.parts[1].input?["query"]?.stringValue, "test")
        XCTAssertEqual(state.parts[2].text, "Hello 日本語")
        XCTAssertEqual(state.metadata["reasoningTime"]?["r1"], .number(2))
        XCTAssertEqual(state.metadata["reasoningTime"]?["t1"], .number(3))
        XCTAssertTrue(try state.consume(#"{"type":"finish"}"#))
    }

    func testUnknownDataPartsArePreservedButTransientDataIsNotPersisted() throws {
        var state = UIMessageStreamState()
        _ = try state.consume(#"{"type":"data-future","id":"one","data":{"new":true}}"#)
        _ = try state.consume(#"{"type":"data-progress","transient":true,"data":"loading"}"#)
        XCTAssertEqual(state.parts.count, 1)
        XCTAssertEqual(state.parts[0].data?["new"], .bool(true))
    }

    func testDeltasWithoutStartAndMalformedToolResultsFailLoudly() {
        var state = UIMessageStreamState()
        XCTAssertThrowsError(try state.consume(#"{"type":"text-delta","id":"missing","delta":"text"}"#))
        XCTAssertThrowsError(try state.consume(#"{"type":"tool-output-available","toolCallId":"missing","output":true}"#))
    }
}
