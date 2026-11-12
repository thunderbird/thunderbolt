/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class NativeACPUpdateTranslatorTests: XCTestCase {
    func testTextThoughtToolAndConfigurationUpdates() {
        XCTAssertEqual(NativeACPUpdateTranslator.translate(.object([
            "sessionUpdate": .string("agent_message_chunk"),
            "content": .object(["type": .string("text"), "text": .string("Hello")]),
        ])), [.text("Hello")])
        XCTAssertEqual(NativeACPUpdateTranslator.translate(.object([
            "sessionUpdate": .string("agent_thought_chunk"),
            "content": .object(["type": .string("text"), "text": .string("Thinking")]),
        ])), [.reasoning("Thinking")])
        XCTAssertEqual(NativeACPUpdateTranslator.translate(.object([
            "sessionUpdate": .string("tool_call_update"), "toolCallId": .string("call-1"),
            "title": .string("Read file"), "status": .string("completed"),
            "rawOutput": .string("contents"),
        ])), [.toolCallUpdate(id: "call-1", title: "Read file", input: nil, status: "completed", output: .string("contents"))])
        XCTAssertEqual(NativeACPUpdateTranslator.translate(.object([
            "sessionUpdate": .string("current_mode_update"), "currentModeId": .string("code"),
        ])), [.modeChanged("code")])
    }

    func testUnknownAndNonTextUpdatesAreIgnored() {
        XCTAssertTrue(NativeACPUpdateTranslator.translate(.object(["sessionUpdate": .string("available_commands_update")])).isEmpty)
        XCTAssertTrue(NativeACPUpdateTranslator.translate(.object([
            "sessionUpdate": .string("agent_message_chunk"), "content": .object(["type": .string("image")]),
        ])).isEmpty)
    }
}
