/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Observation

enum NativeVoiceSessionState: Equatable {
    case idle
    case listening
    case thinking
    case speaking
}

typealias NativeVoiceReplyHandler = @Sendable (
    _ conversationID: String,
    _ userText: String
) async throws -> AsyncThrowingStream<String, Error>
typealias NativeVoiceTranscriptHandler = @Sendable (_ text: String, _ role: String) -> Void

/// Owns one microphone, inference, and playback lifetime. Call `start()` only from
/// an explicit user action; stopping cancels the active assistant turn as well.
@MainActor
@Observable
final class NativeVoiceSession {
    private(set) var state: NativeVoiceSessionState = .idle
    private(set) var lastError: String?
    private(set) var inputLevel: Float = 0

    @ObservationIgnored private let conversationID: String
    @ObservationIgnored private let engine: any NativeVoiceEngine
    @ObservationIgnored private let capture: any NativeVoiceCapturing
    @ObservationIgnored private let playback: any NativeVoicePlaying
    @ObservationIgnored private let reply: NativeVoiceReplyHandler
    @ObservationIgnored private let onTranscript: NativeVoiceTranscriptHandler
    @ObservationIgnored private var activeTurn: Task<Void, Never>?
    @ObservationIgnored private var activeTurnID: UUID?
    @ObservationIgnored private var startupID: UUID?
    @ObservationIgnored private var startupTaskID: UUID?
    @ObservationIgnored private var startupTask: Task<Void, Error>?
    @ObservationIgnored private var started = false

    init(
        conversationID: String,
        engine: any NativeVoiceEngine,
        capture: any NativeVoiceCapturing = NativeVoiceAudioCapture(),
        playback: any NativeVoicePlaying = NativeVoiceAudioPlayback(),
        reply: @escaping NativeVoiceReplyHandler,
        onTranscript: @escaping NativeVoiceTranscriptHandler = { _, _ in }
    ) {
        self.conversationID = conversationID
        self.engine = engine
        self.capture = capture
        self.playback = playback
        self.reply = reply
        self.onTranscript = onTranscript
        capture.setHandlers(
            onSpeechStart: { [weak self] in
                Task { @MainActor in self?.interruptForBargeIn() }
            },
            onUtterance: { [weak self] samples in
                Task { @MainActor in self?.beginTurn(samples) }
            },
            onLevel: { [weak self] level in
                Task { @MainActor in self?.inputLevel = level }
            },
            onInterruption: { [weak self] in
                Task { @MainActor in await self?.stop() }
            }
        )
    }

    func start() async throws {
        guard !started, startupTask == nil else { return }
        lastError = nil
        let startID = UUID()
        startupID = startID
        startupTaskID = startID
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            try await self.performStart(startID)
        }
        startupTask = task
        defer {
            if startupTaskID == startID {
                startupTaskID = nil
                startupTask = nil
            }
        }
        try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func performStart(_ startID: UUID) async throws {
        do {
            try await engine.prepare()
            try Task.checkCancellation()
            guard startupID == startID else { return }
            try await capture.start()
            try Task.checkCancellation()
            guard startupID == startID else {
                capture.stop()
                return
            }
            startupID = nil
            started = true
            capture.setListening(true)
            state = .listening
        } catch {
            capture.stop()
            guard startupID == startID else { return }
            startupID = nil
            await engine.dispose()
            lastError = error.localizedDescription
            throw error
        }
    }

    func stop() async {
        guard started || activeTurn != nil || startupID != nil || startupTask != nil else { return }
        startupID = nil
        startupTask?.cancel()
        started = false
        activeTurnID = nil
        activeTurn?.cancel()
        activeTurn = nil
        playback.stop()
        capture.setListening(false)
        capture.stop()
        inputLevel = 0
        state = .idle
        await engine.dispose()
    }

    private func interruptForBargeIn() {
        guard started, activeTurn != nil else { return }
        activeTurn?.cancel()
        activeTurn = nil
        activeTurnID = nil
        playback.stop()
        state = .listening
    }

    private func beginTurn(_ samples: [Float]) {
        guard started else { return }
        activeTurn?.cancel()
        playback.stop()
        let turnID = UUID()
        activeTurnID = turnID
        activeTurn = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.processTurn(samples, id: turnID)
        }
    }

    private func processTurn(_ samples: [Float], id: UUID) async {
        setTurnState(.thinking, id: id)
        do {
            let wav = NativeVoiceAudioFormat.wav(samples: samples)
            let userText = try await engine.transcribe(wav: wav).trimmingCharacters(in: .whitespacesAndNewlines)
            try Task.checkCancellation()
            guard !NativeVoiceTranscriptFilter.isHallucinated(userText) else {
                finishTurn(id, state: .listening)
                return
            }
            onTranscript(userText, "user")

            var assistantText = ""
            var accumulatedText = ""
            var spokenProjection = ""
            var aggregator = NativeVoiceSentenceAggregator()
            let stream = try await reply(conversationID, userText)
            for try await token in stream {
                try Task.checkCancellation()
                assistantText += token
                accumulatedText += token
                let projection = NativeVoiceText.toSpeakable(accumulatedText)
                guard projection.hasPrefix(spokenProjection) else {
                    spokenProjection = projection
                    continue
                }
                let delta = String(projection.dropFirst(spokenProjection.count))
                spokenProjection = projection
                for chunk in aggregator.push(delta) {
                    try await speak(chunk, id: id)
                }
            }
            for chunk in aggregator.flush() { try await speak(chunk, id: id) }
            try Task.checkCancellation()
            let answer = assistantText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !answer.isEmpty { onTranscript(answer, "assistant") }
            finishTurn(id, state: .listening)
        } catch is CancellationError {
            finishTurn(id, state: started ? .listening : .idle)
        } catch {
            if activeTurnID == id {
                lastError = error.localizedDescription
                finishTurn(id, state: .listening)
            }
        }
    }

    private func speak(_ text: String, id: UUID) async throws {
        let clean = NativeVoiceText.toSpeakable(text)
        guard !clean.isEmpty, started, activeTurnID == id else { return }
        state = .speaking
        let audio = try await engine.synthesize(text: clean)
        try Task.checkCancellation()
        guard started, activeTurnID == id else { throw CancellationError() }
        try await playback.play(audio)
        try Task.checkCancellation()
        guard started, activeTurnID == id else { throw CancellationError() }
        state = .thinking
    }

    private func setTurnState(_ nextState: NativeVoiceSessionState, id: UUID) {
        guard started, activeTurnID == id else { return }
        state = nextState
    }

    private func finishTurn(_ id: UUID, state nextState: NativeVoiceSessionState) {
        guard activeTurnID == id else { return }
        activeTurnID = nil
        activeTurn = nil
        if started { state = nextState }
        else { state = .idle }
    }
}

enum NativeVoiceTranscriptFilter {
    private static let noisePhrases = [
        "thanks for watching", "thank you for watching", "thank you for your watching",
        "please subscribe", "like and subscribe", "see you next time", "see you in the next video", "you",
    ]

    static func isHallucinated(_ text: String) -> Bool {
        let normalized = text.lowercased()
            .replacingOccurrences(of: "[^a-z\\s]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return true }
        var remainder = " \(normalized) "
        var previous = ""
        while previous != remainder {
            previous = remainder
            for phrase in noisePhrases { remainder = remainder.replacingOccurrences(of: " \(phrase) ", with: " ") }
        }
        return remainder.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
