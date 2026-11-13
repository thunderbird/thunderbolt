/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI
import UIKit

struct ContentView: View {
    @Bindable var model: AppModel

    var body: some View {
        Group {
            if model.isRestoring {
                ProgressView(nativeString( "Loading Thunderbolt…"))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(TBPalette.background)
            } else if model.session == nil {
                SignInView(model: model)
            } else if model.requiresInitialSyncSetup {
                SyncSetupView(model: model, allowsDismissal: false)
            } else {
                ChatView(model: model)
            }
        }
        .tint(TBPalette.brand)
        .foregroundStyle(TBPalette.foreground)
        .background(TBPalette.background.ignoresSafeArea())
    }
}

enum TBPalette {
    static let background = Color(light: 0xF5F2EE, dark: 0x1B1E1F)
    static let sidebar = Color(light: 0xEBE7E0, dark: 0x252827)
    static let surface = Color(light: 0xFAF8F5, dark: 0x282A2B)
    static let composer = Color(light: 0xFEFDFB, dark: 0x282A2B)
    static let secondary = Color(light: 0xF0EDE6, dark: 0x313334)
    static let foreground = Color(light: 0x262120, dark: 0xF2F1EE)
    static let muted = Color(light: 0x7F7870, dark: 0xA19A91)
    static let border = Color(light: 0xE5DFD5, dark: 0x434546)
    static let brand = Color(light: 0xC12D6C, dark: 0xC12D6C)
    static let brandAmber = Color(light: 0xAB5E17, dark: 0xAB5E17)
    static let brandForeground = Color(light: 0xFAF8F5, dark: 0xFAF8F5)
}

struct TBPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isEnabled ? TBPalette.brandForeground : TBPalette.muted)
            .background {
                if isEnabled {
                    LinearGradient(
                        colors: [TBPalette.brandAmber, TBPalette.brand],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                } else {
                    TBPalette.secondary
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .opacity(configuration.isPressed && isEnabled ? 0.92 : 1)
    }
}

private extension Color {
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }
}

struct ThunderboltMark: View {
    var size: CGFloat = 72
    var opacity: Double = 1

    var body: some View {
        Image("ThunderboltMark")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .opacity(opacity)
            .accessibilityHidden(true)
    }
}
