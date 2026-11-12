/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import AVFAudio
import Foundation

@MainActor
protocol NativeVoicePlaying: AnyObject {
    func play(_ audio: Data) async throws
    func stop()
}

@MainActor
final class NativeVoiceAudioPlayback: NativeVoicePlaying {
    private var player: AVAudioPlayer?

    func play(_ audio: Data) async throws {
        try Task.checkCancellation()
        guard let player = try? AVAudioPlayer(data: audio), player.prepareToPlay(), player.play() else {
            throw NativeVoiceEngineError.invalidAudio
        }
        self.player = player
        defer { self.player = nil }
        while player.isPlaying {
            try Task.checkCancellation()
            try await Task.sleep(for: .milliseconds(35))
        }
    }

    func stop() {
        player?.stop()
        player = nil
    }
}
