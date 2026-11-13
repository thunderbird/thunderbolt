/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class NativeVoiceTextTests: XCTestCase {
    func testSpeakablePreservesWordsAndRemovesMarkupAndEmoji() {
        XCTAssertEqual(
            NativeVoiceText.toSpeakable("# Hello **world** 2026 ✅ [docs](https://example.com)"),
            "Hello world 2026 docs"
        )
        XCTAssertEqual(
            NativeVoiceText.toSpeakable("Before. <widget:ask question='Continue?'/ >"),
            "Before. Please choose one of the options on screen."
        )
        XCTAssertEqual(NativeVoiceText.toSpeakable("```swift\nlet answer = 42\n```"), "")
    }

    func testSentenceAggregatorKeepsAbbreviationsAndFlushesRemainder() {
        var aggregator = NativeVoiceSentenceAggregator()
        XCTAssertEqual(
            aggregator.push("Here is the plan for today. Dr. Lee arrived. Then she left."),
            ["Here is the plan for today.", "Dr. Lee arrived."]
        )
        XCTAssertEqual(aggregator.flush(), ["Then she left."])
    }

    func testTranscriptFilterDropsOnlyCaptionFiller() {
        XCTAssertTrue(NativeVoiceTranscriptFilter.isHallucinated("Thanks for watching. Please subscribe."))
        XCTAssertTrue(NativeVoiceTranscriptFilter.isHallucinated("   "))
        XCTAssertFalse(NativeVoiceTranscriptFilter.isHallucinated("Thank you for helping me."))
        XCTAssertFalse(NativeVoiceTranscriptFilter.isHallucinated("Bye"))
    }
}
