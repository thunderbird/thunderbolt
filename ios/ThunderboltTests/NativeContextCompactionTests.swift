/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class NativeContextCompactionTests: XCTestCase {
    func testBoundaryKeepsUnansweredPromptAndEmptyStoppedTurnOutsideSummary() {
        let messages = [ChatMessage(role: .user, text: "Earlier"), ChatMessage(role: .assistant, text: "Answer"),
                        ChatMessage(role: .user, text: "Unanswered"), ChatMessage(role: .assistant, text: " ")]
        XCTAssertEqual(NativeContextCompaction.boundary(in: messages), 1)
        XCTAssertNil(NativeContextCompaction.boundary(in: [ChatMessage(role: .user, text: "First question")]))
    }

    func testCheckpointPreservesMessageContentUsageAndUnknownMetadata() throws {
        let checkpoint: ChatJSONValue = .object(["version": .number(1), "summary": .string("Earlier context"),
            "retainedTail": .array([]), "contextTokens": .number(50), "tokensBefore": .number(200)])
        let message = ChatMessage(role: .assistant, text: "Original answer", metadata: .object([
            "usage": .object(["totalTokens": .number(200)]), "futureField": .bool(true)]))
        let updated = try NativeContextCompaction.applying(checkpoint, to: message)
        XCTAssertEqual(updated.text, message.text)
        XCTAssertEqual(updated.id, message.id)
        XCTAssertEqual(updated.metadata?["futureField"], .bool(true))
        XCTAssertEqual(updated.metadata?["usage"], message.metadata?["usage"])
        XCTAssertEqual(updated.metadata?["contextCompaction"], checkpoint)
        XCTAssertEqual(NativeContextCompaction.contextSize(in: updated.metadata), 50)
    }

    func testInvalidCheckpointDoesNotReplaceExistingContext() {
        let original = ChatMessage(role: .assistant, text: "Answer")
        XCTAssertThrowsError(try NativeContextCompaction.applying(.object([
            "version": .number(2), "summary": .string("Wrong version"),
            "retainedTail": .array([]), "contextTokens": .number(4)]), to: original))
        XCTAssertNil(NativeContextCompaction.contextSize(in: .object(["contextTokens": .number(-1)])))
        XCTAssertNil(NativeContextCompaction.contextSize(in: .object(["contextTokens": .number(.infinity)])))
        XCTAssertEqual(NativeContextCompaction.contextSize(in: .object(["usage": .object(["totalTokens": .number(42)])])), 42)
    }
}
