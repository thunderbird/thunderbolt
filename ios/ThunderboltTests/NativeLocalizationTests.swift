/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
import Observation
@testable import Thunderbolt

final class NativeLocalizationTests: XCTestCase {
    func testSelectedLanguageResolvesSharedLinguiTranslation() {
        let originalLanguage = NativeLocalization.selectedLanguage
        defer { NativeLocalization.setLanguage(originalLanguage) }

        NativeLocalization.setLanguage("de-DE")

        XCTAssertEqual(NativeLocalization.selectedLanguage, "de")
        XCTAssertEqual(nativeString("Settings"), "Einstellungen")
    }

    func testUnsupportedLanguageFallsBackToEnglish() {
        let originalLanguage = NativeLocalization.selectedLanguage
        defer { NativeLocalization.setLanguage(originalLanguage) }

        NativeLocalization.setLanguage("zh-Hans")

        XCTAssertEqual(NativeLocalization.selectedLanguage, "en")
        XCTAssertEqual(nativeString("Settings"), "Settings")
    }

    func testComputedLocalizationReadInvalidatesWhenSelectedLanguageChanges() {
        let originalLanguage = NativeLocalization.selectedLanguage
        defer { NativeLocalization.setLanguage(originalLanguage) }
        let changed = expectation(description: "computed localization observes language changes")

        withObservationTracking {
            _ = nativeString("Settings")
        } onChange: {
            changed.fulfill()
        }
        NativeLocalization.setLanguage(originalLanguage == "de" ? "en" : "de")

        wait(for: [changed], timeout: 1)
    }
}
