/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import AVFAudio
import Foundation

enum NativeVoiceAudioFormat {
    static let sampleRate = 16_000
    static let frameLength = 512

    static func wav(samples: [Float], sampleRate: Int = sampleRate) -> Data {
        let pcmByteCount = samples.count * MemoryLayout<Int16>.size
        var data = Data(capacity: 44 + pcmByteCount)
        func appendASCII(_ value: String) { data.append(contentsOf: value.utf8) }
        func appendLE16(_ value: UInt16) {
            data.append(UInt8(value & 0xff))
            data.append(UInt8((value >> 8) & 0xff))
        }
        func appendLE32(_ value: UInt32) {
            data.append(UInt8(value & 0xff))
            data.append(UInt8((value >> 8) & 0xff))
            data.append(UInt8((value >> 16) & 0xff))
            data.append(UInt8((value >> 24) & 0xff))
        }
        appendASCII("RIFF")
        appendLE32(UInt32(36 + pcmByteCount))
        appendASCII("WAVEfmt ")
        appendLE32(16)
        appendLE16(1)
        appendLE16(1)
        appendLE32(UInt32(sampleRate))
        appendLE32(UInt32(sampleRate * 2))
        appendLE16(2)
        appendLE16(16)
        appendASCII("data")
        appendLE32(UInt32(pcmByteCount))
        for sample in samples {
            let clamped = max(-1, min(1, sample))
            let scaled = clamped < 0 ? clamped * 32_768 : clamped * 32_767
            appendLE16(UInt16(bitPattern: Int16(scaled)))
        }
        return data
    }
}

/// The same energy endpointing thresholds used by the shared web voice loop.
final class NativeVoiceEndpointer {
    static let speechRmsThreshold: Float = 0.015
    static let minimumSpeechFrames = 8
    static let trailingSilenceFrames = 45
    static let prerollFrameCount = 4

    private var listening = true
    private var speaking = false
    private var preroll: [[Float]] = []
    private var collected: [[Float]] = []
    private var speechFrames = 0
    private var silenceFrames = 0
    private var bargeInFired = false

    var onSpeechStart: (@Sendable () -> Void)?
    var onUtterance: (@Sendable ([Float]) -> Void)?
    var onMisfire: (@Sendable () -> Void)?
    var onLevel: (@Sendable (Float) -> Void)?

    func setListening(_ value: Bool) {
        listening = value
        if !value { clear() }
    }

    func processFrame(_ frame: [Float]) {
        guard listening, !frame.isEmpty else { return }
        let level = Self.rms(frame)
        onLevel?(level)
        if level >= Self.speechRmsThreshold {
            if !speaking {
                speaking = true
                collected = preroll
            }
            collected.append(frame)
            silenceFrames = 0
            speechFrames += 1
            if !bargeInFired && speechFrames >= Self.minimumSpeechFrames {
                bargeInFired = true
                onSpeechStart?()
            }
            return
        }

        guard speaking else {
            preroll.append(frame)
            if preroll.count > Self.prerollFrameCount { preroll.removeFirst() }
            return
        }
        collected.append(frame)
        silenceFrames += 1
        if silenceFrames >= Self.trailingSilenceFrames { finishUtterance() }
    }

    func clear() {
        speaking = false
        collected.removeAll(keepingCapacity: true)
        preroll.removeAll(keepingCapacity: true)
        speechFrames = 0
        silenceFrames = 0
        bargeInFired = false
    }

    static func rms(_ frame: [Float]) -> Float {
        guard !frame.isEmpty else { return 0 }
        let sum = frame.reduce(Float.zero) { $0 + $1 * $1 }
        return sqrt(sum / Float(frame.count))
    }

    private func finishUtterance() {
        let speechCount = speechFrames
        let samples = collected.flatMap { $0 }
        clear()
        if speechCount < Self.minimumSpeechFrames { onMisfire?() }
        else { onUtterance?(samples) }
    }
}

@MainActor
protocol NativeVoiceCapturing: AnyObject {
    func setHandlers(
        onSpeechStart: @escaping @Sendable () -> Void,
        onUtterance: @escaping @Sendable ([Float]) -> Void,
        onLevel: @escaping @Sendable (Float) -> Void,
        onInterruption: @escaping @Sendable () -> Void
    )
    func start() async throws
    func setListening(_ listening: Bool)
    func stop()
}

@MainActor
final class NativeVoiceAudioCapture: NativeVoiceCapturing {
    private let engine = AVAudioEngine()
    private let processor = NativeVoiceAudioProcessor()
    private var tapInstalled = false
    private var started = false
    private var interruptionObserver: NSObjectProtocol?

    func setHandlers(
        onSpeechStart: @escaping @Sendable () -> Void,
        onUtterance: @escaping @Sendable ([Float]) -> Void,
        onLevel: @escaping @Sendable (Float) -> Void,
        onInterruption: @escaping @Sendable () -> Void
    ) {
        processor.setHandlers(
            onSpeechStart: onSpeechStart,
            onUtterance: onUtterance,
            onLevel: onLevel,
            onInterruption: onInterruption
        )
    }

    func start() async throws {
        guard await Self.requestMicrophoneAccess() else { throw NativeVoiceEngineError.microphonePermissionDenied }
        try Task.checkCancellation()
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        if interruptionObserver == nil {
            interruptionObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: session,
                queue: .main
            ) { [weak processor] notification in
                guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      AVAudioSession.InterruptionType(rawValue: rawType) == .began else { return }
                processor?.notifyInterruption()
            }
        }

        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw NativeVoiceEngineError.microphoneUnavailable
        }
        try processor.configure(inputFormat: inputFormat)
        input.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) { [processor] buffer, _ in
            processor.consume(buffer)
        }
        tapInstalled = true
        do {
            try engine.start()
            started = true
        } catch {
            stop()
            throw error
        }
    }

    func setListening(_ listening: Bool) { processor.setListening(listening) }

    func stop() {
        processor.setListening(false)
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        if started { engine.stop(); started = false }
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
            self.interruptionObserver = nil
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func requestMicrophoneAccess() async -> Bool {
        if AVAudioApplication.shared.recordPermission == .granted { return true }
        if AVAudioApplication.shared.recordPermission == .denied { return false }
        return await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in continuation.resume(returning: granted) }
        }
    }
}

private final class NativeVoiceAudioProcessor: @unchecked Sendable {
    private let lock = NSLock()
    private let endpointer = NativeVoiceEndpointer()
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private var pending: [Float] = []
    private var onInterruption: (@Sendable () -> Void)?

    func setHandlers(
        onSpeechStart: @escaping @Sendable () -> Void,
        onUtterance: @escaping @Sendable ([Float]) -> Void,
        onLevel: @escaping @Sendable (Float) -> Void,
        onInterruption: @escaping @Sendable () -> Void
    ) {
        lock.lock()
        endpointer.onSpeechStart = onSpeechStart
        endpointer.onUtterance = onUtterance
        endpointer.onLevel = onLevel
        self.onInterruption = onInterruption
        lock.unlock()
    }

    func notifyInterruption() {
        lock.lock()
        let callback = onInterruption
        lock.unlock()
        callback?()
    }

    func setListening(_ listening: Bool) {
        lock.lock()
        endpointer.setListening(listening)
        lock.unlock()
    }

    func configure(inputFormat: AVAudioFormat) throws {
        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: inputFormat, to: target) else {
            throw NativeVoiceEngineError.microphoneUnavailable
        }
        lock.lock()
        self.targetFormat = target
        self.converter = converter
        pending.removeAll(keepingCapacity: true)
        lock.unlock()
    }

    func consume(_ input: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard let converter, let targetFormat else { return }
        let ratio = targetFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * ratio) + 64)
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
        let inputState = NativeVoiceConverterInputState(buffer: input)
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            guard let buffer = inputState.takeNext() else {
                inputStatus.pointee = .noDataNow
                return nil
            }
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, conversionError == nil,
              let samples = output.floatChannelData?.pointee,
              output.frameLength > 0 else { return }
        for index in 0..<Int(output.frameLength) { pending.append(samples[index]) }
        while pending.count >= NativeVoiceAudioFormat.frameLength {
            let frame = Array(pending.prefix(NativeVoiceAudioFormat.frameLength))
            pending.removeFirst(NativeVoiceAudioFormat.frameLength)
            endpointer.processFrame(frame)
        }
    }
}

/// The tap buffer remains valid for the synchronous converter call. This immutable
/// wrapper is the only value captured by AVAudioConverter's Sendable input block.
private final class NativeVoicePCMInputBuffer: @unchecked Sendable {
    let value: AVAudioPCMBuffer

    init(_ value: AVAudioPCMBuffer) { self.value = value }
}

/// Serializes the converter's one-shot read without capturing mutable locals in its
/// Sendable callback. The converter input block may be invoked on another thread.
private final class NativeVoiceConverterInputState: @unchecked Sendable {
    private let lock = NSLock()
    private let input: NativeVoicePCMInputBuffer
    private var didProvideInput = false

    init(buffer: AVAudioPCMBuffer) { input = NativeVoicePCMInputBuffer(buffer) }

    func takeNext() -> AVAudioPCMBuffer? {
        lock.lock()
        defer { lock.unlock() }
        guard !didProvideInput else { return nil }
        didProvideInput = true
        return input.value
    }
}
