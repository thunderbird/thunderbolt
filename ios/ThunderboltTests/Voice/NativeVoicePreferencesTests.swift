/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class NativeVoicePreferencesTests: XCTestCase {
    func testCustomEndpointRequiresHTTPSOrLoopbackHTTP() throws {
        XCTAssertEqual(try NativeVoiceConfiguration.validatedBaseURL("https://speech.example/v1/").absoluteString, "https://speech.example/v1")
        XCTAssertEqual(try NativeVoiceConfiguration.validatedBaseURL("http://localhost:8880/v1").host, "localhost")
        XCTAssertThrowsError(try NativeVoiceConfiguration.validatedBaseURL("http://speech.example/v1"))
        XCTAssertThrowsError(try NativeVoiceConfiguration.validatedBaseURL("https://user:pass@speech.example/v1"))
        XCTAssertThrowsError(try NativeVoiceConfiguration.validatedBaseURL("https://speech.example/v1?token=x"))
    }

    func testModelClassificationMatchesOpenAICompatibleConventions() {
        let models = NativeVoiceDiscoveredModels.classify([
            NativeVoiceModelOption(id: "whisper", task: "automatic-speech-recognition", voices: []),
            NativeVoiceModelOption(id: "kokoro", task: "text-to-speech", voices: ["af_bella"]),
            NativeVoiceModelOption(id: "generic", task: nil, voices: []),
        ])
        XCTAssertEqual(models.stt, ["whisper", "generic"])
        XCTAssertEqual(models.tts.map(\.id), ["kokoro", "generic"])
        XCTAssertEqual(models.tts[0].voices, ["af_bella"])
    }
}
