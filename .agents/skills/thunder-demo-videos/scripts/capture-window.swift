// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import Foundation
import AppKit
import ScreenCaptureKit
import AVFoundation
import CoreMedia

struct CaptureRect: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct CaptureConfig: Decodable {
    let windowID: UInt32
    let expectedBundleID: String
    let expectedTitle: String?
    let output: String
    let seconds: Double
    let width: Int?
    let fps: Int?
    let crop: CaptureRect?
}

enum CaptureError: Error {
    case invalid(String)
}

@available(macOS 15.0, *)
final class RecordingDelegate: NSObject, SCRecordingOutputDelegate {
    private let lock = NSLock()
    private var result: Result<Void, Error>?
    private var continuation: CheckedContinuation<Void, Error>?

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        print("RECORDING_STARTED")
        fflush(stdout)
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        complete(.failure(error))
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        complete(.success(()))
    }

    private func complete(_ value: Result<Void, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(with: value)
    }

    func waitUntilFinished() async throws {
        try await withCheckedThrowingContinuation { pending in
            lock.lock()
            if let result {
                lock.unlock()
                pending.resume(with: result)
            } else {
                continuation = pending
                lock.unlock()
            }
        }
    }
}

@main
struct WindowCapture {
    @MainActor
    static func main() async throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        guard #available(macOS 15.0, *) else {
            throw CaptureError.invalid("Native MP4 recording requires macOS 15 or newer")
        }
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            throw CaptureError.invalid("Usage: capture-window list [BUNDLE_ID] [TITLE] | record CONFIG.json")
        }
        if args[1] == "list" {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            for window in content.windows {
                guard let owner = window.owningApplication else { continue }
                let matches = args.count > 2 ? owner.bundleIdentifier == args[2] : owner.applicationName.localizedCaseInsensitiveContains("Thunderbolt")
                guard matches, args.count < 4 || window.title == args[3] else { continue }
                print("ID=\(window.windowID) BUNDLE=\(owner.bundleIdentifier) TITLE=\(window.title ?? "") FRAME=\(window.frame)")
            }
            return
        }
        guard args[1] == "record", args.count == 3 else {
            throw CaptureError.invalid("Expected record CONFIG.json")
        }
        let config = try JSONDecoder().decode(CaptureConfig.self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
        guard config.seconds.isFinite, config.seconds > 0, config.seconds <= 600, (1...60).contains(config.fps ?? 60) else {
            throw CaptureError.invalid("Use a positive duration up to 600 seconds and FPS from 1 to 60")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.windowID == config.windowID }),
              window.owningApplication?.bundleIdentifier == config.expectedBundleID,
              config.expectedTitle == nil || config.expectedTitle == window.title else {
            throw CaptureError.invalid("The selected window no longer matches the expected application/title")
        }
        let rect = config.crop.map { CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height) }
            ?? CGRect(origin: .zero, size: window.frame.size)
        guard [rect.origin.x, rect.origin.y, rect.width, rect.height].allSatisfy({ $0.isFinite }),
              rect.width > 0, rect.height > 0, CGRect(origin: .zero, size: window.frame.size).contains(rect) else {
            throw CaptureError.invalid("Crop must fit inside the selected window in logical pixels")
        }
        let output = URL(fileURLWithPath: config.output)
        guard !FileManager.default.fileExists(atPath: output.path) else {
            throw CaptureError.invalid("Choose a new output file; raw captures are immutable")
        }
        try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
        let streamConfig = SCStreamConfiguration()
        streamConfig.sourceRect = rect
        let width = config.width ?? min(1920, Int(rect.width * 2))
        guard (2...8192).contains(width) else {
            throw CaptureError.invalid("Output width must be from 2 to 8192 pixels")
        }
        let height = Double(width / 2 * 2) * rect.height / rect.width
        guard height.isFinite, height >= 2, height <= 8192 else {
            throw CaptureError.invalid("Output height must be from 2 to 8192 pixels; check crop and width")
        }
        streamConfig.width = width / 2 * 2
        streamConfig.height = Int(height) / 2 * 2
        streamConfig.minimumFrameInterval = CMTime(value: 1, timescale: Int32(config.fps ?? 60))
        streamConfig.queueDepth = 6
        streamConfig.showsCursor = true
        streamConfig.capturesAudio = false
        streamConfig.captureMicrophone = false
        streamConfig.ignoreShadowsSingleWindow = true
        streamConfig.captureResolution = .best
        let outputConfig = SCRecordingOutputConfiguration()
        outputConfig.outputURL = output
        outputConfig.videoCodecType = .h264
        outputConfig.outputFileType = .mp4
        let delegate = RecordingDelegate()
        let recording = SCRecordingOutput(configuration: outputConfig, delegate: delegate)
        let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: streamConfig, delegate: nil)
        try stream.addRecordingOutput(recording)
        print("WINDOW \(window.windowID) \(streamConfig.width)x\(streamConfig.height) TARGET_FPS=\(config.fps ?? 60) AUDIO_OFF")
        fflush(stdout)
        try await stream.startCapture()
        try await Task.sleep(nanoseconds: UInt64(config.seconds * 1_000_000_000))
        try await stream.stopCapture()
        try await delegate.waitUntilFinished()
        print("RECORDING_FINISHED \(output.path)")
    }
}
