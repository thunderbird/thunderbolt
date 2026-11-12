/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Observation
import SwiftUI

/// Device-only preferences; these values intentionally stay out of synced settings.
@MainActor
@Observable
final class NativeDevicePreferences {
    static let shared = NativeDevicePreferences()

    private(set) var theme: String?
    private(set) var externalLinkBehavior: String
    private(set) var hapticsEnabled: Bool

    @ObservationIgnored private let defaults: UserDefaults

    var preferredColorScheme: ColorScheme? {
        switch theme {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.theme = defaults.string(forKey: "theme")
        self.externalLinkBehavior = defaults.string(forKey: "externalLinkBehavior") ?? "ask"
        self.hapticsEnabled = defaults.object(forKey: "hapticsEnabled") as? Bool ?? true
    }

    func setTheme(_ value: String?) {
        guard value == nil || ["light", "dark"].contains(value) else { return }
        theme = value
        defaults.set(value, forKey: "theme")
    }

    func setExternalLinkBehavior(_ value: String) {
        guard ["ask", "browser"].contains(value) else { return }
        externalLinkBehavior = value
        defaults.set(value, forKey: "externalLinkBehavior")
    }

    func setHapticsEnabled(_ enabled: Bool) {
        hapticsEnabled = enabled
        defaults.set(enabled, forKey: "hapticsEnabled")
    }
}
