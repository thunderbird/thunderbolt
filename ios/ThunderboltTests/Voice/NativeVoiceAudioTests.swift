/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class NativeVoiceAudioTests: XCTestCase {
    func testWAVUsesMono16BitPCMAtSixteenKilohertz() throws {
        let data = NativeVoiceAudioFormat.wav(samples: [-1, 0, 1])
        XCTAssertEqual(String(decoding: data.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: data[8..<12], as: UTF8.self), "WAVE")
        XCTAssertEqual(data.count, 50)
        XCTAssertEqual(Array(data[24..<28]), [0x80, 0x3e, 0, 0]) // 16,000 Hz
        XCTAssertEqual(Array(data[44..<50]), [0, 128, 0, 0, 255, 127])
    }

    func testEndpointerCommitsSustainedSpeechAfterTrailingSilence() {
        let committed = expectation(description: "utterance committed")
        let started = expectation(description: "speech start fired")
        let endpointer = NativeVoiceEndpointer()
        endpointer.onSpeechStart = { started.fulfill() }
        endpointer.onUtterance = { samples in
            XCTAssertEqual(samples.count, (8 + NativeVoiceEndpointer.trailingSilenceFrames) * 512)
            committed.fulfill()
        }
        let speech = [Float](repeating: 0.1, count: 512)
        let silence = [Float](repeating: 0, count: 512)
        for _ in 0..<8 { endpointer.processFrame(speech) }
        for _ in 0..<NativeVoiceEndpointer.trailingSilenceFrames { endpointer.processFrame(silence) }
        wait(for: [started, committed], timeout: 1)
    }

    func testEndpointerIgnoresShortBlips() {
        let misfire = expectation(description: "short sound rejected")
        let endpointer = NativeVoiceEndpointer()
        endpointer.onMisfire = { misfire.fulfill() }
        for _ in 0..<2 { endpointer.processFrame([Float](repeating: 0.2, count: 512)) }
        for _ in 0..<NativeVoiceEndpointer.trailingSilenceFrames { endpointer.processFrame([Float](repeating: 0, count: 512)) }
        wait(for: [misfire], timeout: 1)
    }
}
