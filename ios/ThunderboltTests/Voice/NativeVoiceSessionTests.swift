/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

@MainActor
final class NativeVoiceSessionTests: XCTestCase {
    func testCaptureStartsOnlyAfterExplicitStartAndStopsWithSession() async throws {
        let capture = FakeVoiceCapture()
        let session = NativeVoiceSession(
            conversationID: "chat-1",
            engine: FakeVoiceEngine(),
            capture: capture,
            playback: FakeVoicePlayback(),
            reply: { _, _ in AsyncThrowingStream { $0.finish() } }
        )
        XCTAssertFalse(capture.started)
        try await session.start()
        XCTAssertTrue(capture.started)
        XCTAssertEqual(session.state, .listening)
        await session.stop()
        XCTAssertFalse(capture.started)
        XCTAssertEqual(session.state, .idle)
    }

    func testTranscriptionFeedsReplyAndSpeaksSanitizedAssistantText() async throws {
        let capture = FakeVoiceCapture()
        let playback = FakeVoicePlayback()
        let replyInputs = VoiceReplyInputs()
        let transcripts = expectation(description: "both turn transcripts emitted")
        transcripts.expectedFulfillmentCount = 2
        let session = NativeVoiceSession(
            conversationID: "chat-2",
            engine: FakeVoiceEngine(),
            capture: capture,
            playback: playback,
            reply: { conversationID, userText in
                await replyInputs.record(conversationID: conversationID, text: userText)
                return AsyncThrowingStream { continuation in
                    continuation.yield("The answer is 42. ✅")
                    continuation.finish()
                }
            },
            onTranscript: { _, _ in transcripts.fulfill() }
        )
        try await session.start()
        capture.emitUtterance([Float](repeating: 0.1, count: 8_000))
        await fulfillment(of: [transcripts], timeout: 2)
        let input = await replyInputs.value
        XCTAssertEqual(input?.conversationID, "chat-2")
        XCTAssertEqual(input?.text, "A question")
        XCTAssertEqual(playback.playedText, ["The answer is 42."])
        XCTAssertEqual(session.state, .listening)
        await session.stop()
    }

    func testBargeInCancelsCurrentPlaybackAndKeepsTheMicOpen() async throws {
        let capture = FakeVoiceCapture()
        let playback = FakeVoicePlayback()
        let replyStarted = expectation(description: "reply stream entered")
        let session = NativeVoiceSession(
            conversationID: "chat-3",
            engine: FakeVoiceEngine(),
            capture: capture,
            playback: playback,
            reply: { _, _ in
                AsyncThrowingStream { continuation in
                    continuation.yield("First sentence.")
                    replyStarted.fulfill()
                    continuation.onTermination = { _ in }
                }
            }
        )
        try await session.start()
        capture.emitUtterance([Float](repeating: 0.1, count: 8_000))
        await fulfillment(of: [replyStarted], timeout: 2)
        capture.emitSpeechStart()
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(capture.started)
        XCTAssertGreaterThan(playback.stopCount, 0)
        XCTAssertEqual(session.state, .listening)
        await session.stop()
    }

    func testStopCancelsAnOpenAssistantStreamAndTearsDownAudio() async throws {
        let capture = FakeVoiceCapture()
        let playback = FakeVoicePlayback()
        let replyStarted = expectation(description: "reply stream entered")
        let streamCancelled = expectation(description: "reply stream cancelled")
        let session = NativeVoiceSession(
            conversationID: "chat-stop",
            engine: FakeVoiceEngine(),
            capture: capture,
            playback: playback,
            reply: { _, _ in
                AsyncThrowingStream { continuation in
                    continuation.yield("A partial answer.")
                    replyStarted.fulfill()
                    continuation.onTermination = { termination in
                        if case .cancelled = termination { streamCancelled.fulfill() }
                    }
                }
            }
        )
        try await session.start()
        capture.emitUtterance([Float](repeating: 0.1, count: 8_000))
        await fulfillment(of: [replyStarted], timeout: 2)

        await session.stop()
        await fulfillment(of: [streamCancelled], timeout: 2)

        XCTAssertFalse(capture.started)
        XCTAssertGreaterThan(playback.stopCount, 0)
        XCTAssertEqual(session.state, .idle)
    }

    func testStopDuringMicrophonePermissionDoesNotLeaveCaptureRunning() async throws {
        let capture = DelayedVoiceCapture()
        let engine = FakeVoiceEngine()
        let session = NativeVoiceSession(
            conversationID: "chat-startup-stop",
            engine: engine,
            capture: capture,
            playback: FakeVoicePlayback(),
            reply: { _, _ in AsyncThrowingStream { $0.finish() } }
        )
        let startTask = Task { try await session.start() }
        await fulfillment(of: [capture.startEntered], timeout: 2)

        await session.stop()
        capture.releaseStart()
        try await startTask.value

        XCTAssertFalse(capture.started)
        XCTAssertEqual(session.state, .idle)
        XCTAssertGreaterThanOrEqual(capture.stopCount, 2)
        try await session.start()
        XCTAssertTrue(capture.started)
        await session.stop()
    }
}

@MainActor
private final class FakeVoiceCapture: NativeVoiceCapturing {
    private var onSpeechStart: (@Sendable () -> Void)?
    private var onUtterance: (@Sendable ([Float]) -> Void)?
    private var onLevel: (@Sendable (Float) -> Void)?
    private(set) var started = false

    func setHandlers(
        onSpeechStart: @escaping @Sendable () -> Void,
        onUtterance: @escaping @Sendable ([Float]) -> Void,
        onLevel: @escaping @Sendable (Float) -> Void,
        onInterruption: @escaping @Sendable () -> Void
    ) {
        self.onSpeechStart = onSpeechStart
        self.onUtterance = onUtterance
        self.onLevel = onLevel
    }

    func start() async throws { started = true }
    func setListening(_ listening: Bool) {}
    func stop() { started = false }
    func emitUtterance(_ samples: [Float]) { onUtterance?(samples) }
    func emitSpeechStart() { onSpeechStart?() }
}

@MainActor
private final class DelayedVoiceCapture: NativeVoiceCapturing {
    let startEntered = XCTestExpectation(description: "microphone start is pending")
    private var pendingStart: CheckedContinuation<Void, Never>?
    private var startCount = 0
    private(set) var started = false
    private(set) var stopCount = 0

    func setHandlers(
        onSpeechStart: @escaping @Sendable () -> Void,
        onUtterance: @escaping @Sendable ([Float]) -> Void,
        onLevel: @escaping @Sendable (Float) -> Void,
        onInterruption: @escaping @Sendable () -> Void
    ) {}

    func start() async throws {
        startCount += 1
        if startCount == 1 {
            startEntered.fulfill()
            await withCheckedContinuation { pendingStart = $0 }
            started = true
        } else {
            started = true
        }
    }

    func setListening(_ listening: Bool) {}
    func stop() { started = false; stopCount += 1 }

    func releaseStart() {
        pendingStart?.resume()
        pendingStart = nil
    }
}

@MainActor
private final class FakeVoicePlayback: NativeVoicePlaying {
    private(set) var playedText = [String]()
    private(set) var stopCount = 0

    func play(_ audio: Data) async throws {
        playedText.append(String(decoding: audio, as: UTF8.self))
    }

    func stop() { stopCount += 1 }
}

private actor FakeVoiceEngine: NativeVoiceEngine {
    nonisolated let id = "fake"
    func prepare() async throws {}
    func transcribe(wav: Data) async throws -> String { "A question" }
    func synthesize(text: String) async throws -> Data { Data(text.utf8) }
    func dispose() async {}
}

private actor VoiceReplyInputs {
    private(set) var value: (conversationID: String, text: String)?
    func record(conversationID: String, text: String) {
        value = (conversationID, text)
    }
}
