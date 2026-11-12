/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

/// In-place voice surface for the chat composer. It never starts the microphone;
/// the owner starts the session from the explicit voice button action.
struct NativeVoiceComposer: View {
    let state: NativeVoiceSessionState
    let error: String?
    let inputLevel: Float
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            if let error {
                Image(systemName: "mic.slash.fill")
                    .foregroundStyle(.red)
                Text(error)
                    .font(.system(size: 14, weight: .medium))
                    .lineLimit(2)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                NativeVoiceWaveform(state: state, inputLevel: inputLevel)
                    .frame(maxWidth: .infinity)
                    .accessibilityHidden(true)
                Text(state.label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(TBPalette.muted)
                    .fixedSize()
            }

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(TBPalette.background)
                    .frame(width: 34, height: 34)
                    .background(TBPalette.foreground, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(nativeString( "Exit voice mode"))
            .accessibilityIdentifier("exitVoiceMode")
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .background(TBPalette.sidebar, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(TBPalette.border, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voiceModeComposer")
    }
}

private extension NativeVoiceSessionState {
    var label: String {
        switch self {
        case .idle: nativeString( "Starting…")
        case .listening: nativeString( "Listening")
        case .thinking: nativeString( "Thinking")
        case .speaking: nativeString( "Speaking")
        }
    }
}

private struct NativeVoiceWaveform: View {
    let state: NativeVoiceSessionState
    let inputLevel: Float
    private let barCount = 40

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: state == .listening)) { timeline in
            Canvas { context, size in
                let gap: CGFloat = 2
                let barWidth = max(1, (size.width - CGFloat(barCount - 1) * gap) / CGFloat(barCount))
                let phase = timeline.date.timeIntervalSinceReferenceDate
                let level = min(1, sqrt(max(0, Double(inputLevel)) * 6))
                for index in 0..<barCount {
                    let position = (Double(index) + 0.5) / Double(barCount)
                    let hump = sin(position * .pi)
                    let detail = 0.4 * hump + 0.6 * (0.5 + 0.5 * sin(Double(index) * 1.7))
                    let animated: Double
                    switch state {
                    case .idle: animated = 0.12
                    case .listening: animated = 0.08 + level * detail * 0.45
                    case .thinking: animated = 0.12 + (0.1 * (0.5 + 0.5 * sin(phase * 4 + Double(index) * 0.25)))
                    case .speaking: animated = 0.12 + detail * (0.3 + 0.4 * (0.5 + 0.5 * sin(phase * 10 + Double(index) * 0.65)))
                    }
                    let height = max(3, size.height * animated)
                    let rect = CGRect(
                        x: CGFloat(index) * (barWidth + gap),
                        y: (size.height - height) / 2,
                        width: barWidth,
                        height: height
                    )
                    context.fill(Path(roundedRect: rect, cornerRadius: barWidth / 2), with: .color(TBPalette.brand))
                }
            }
        }
        .frame(height: 36)
    }
}
