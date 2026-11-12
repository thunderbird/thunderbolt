/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

@MainActor
final class NativeDevicePreferencesTests: XCTestCase {
    func testDeviceOnlyDefaultsAndUpdatesPersistInUserDefaults() {
        let suite = "NativeDevicePreferencesTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NativeDevicePreferences(defaults: defaults)

        XCTAssertNil(preferences.theme)
        XCTAssertNil(preferences.preferredColorScheme)
        XCTAssertEqual(preferences.externalLinkBehavior, "ask")
        XCTAssertTrue(preferences.hapticsEnabled)

        preferences.setTheme("dark")
        preferences.setExternalLinkBehavior("browser")
        preferences.setHapticsEnabled(false)

        XCTAssertEqual(preferences.preferredColorScheme, .dark)
        XCTAssertEqual(defaults.string(forKey: "theme"), "dark")
        XCTAssertEqual(defaults.string(forKey: "externalLinkBehavior"), "browser")
        XCTAssertFalse(defaults.bool(forKey: "hapticsEnabled"))
    }

    func testInvalidDevicePreferenceValuesAreIgnored() {
        let suite = "NativeDevicePreferencesInvalid-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NativeDevicePreferences(defaults: defaults)

        preferences.setTheme("neon")
        preferences.setExternalLinkBehavior("sidebar")

        XCTAssertNil(preferences.theme)
        XCTAssertEqual(preferences.externalLinkBehavior, "ask")
    }
}
