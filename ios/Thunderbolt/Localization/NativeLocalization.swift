/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Observation

/// Resolves native copy against the app-selected locale, including strings formed outside SwiftUI.
enum NativeLocalization {
    static let supportedLocales = ["en", "de", "es", "fr", "ja", "pt-BR"]

    private static let selection = NativeLocaleSelection()

    static var selectedLanguage: String { selection.language }
    static var language: String { selectedLanguage }

    static func setLanguage(_ value: String) {
        selection.setLanguage(value)
    }

    static func string(_ value: String.LocalizationValue) -> String {
        let language = selectedLanguage
        let bundle = Bundle.main.path(forResource: language, ofType: "lproj")
            .flatMap(Bundle.init(path:)) ?? .main
        return String(localized: value, bundle: bundle, locale: Locale(identifier: language))
    }
}

/// A lock-protected locale value so synchronous error and model strings are safe on any executor.
private final class NativeLocaleSelection: Observable, @unchecked Sendable {
    private let lock = NSLock()
    private let registrar = ObservationRegistrar()
    private var selected: String

    init() {
        let preferred = Locale.preferredLanguages.first ?? "en"
        let baseLanguage = String(preferred.split(separator: "-").first ?? "en")
        selected = NativeLocalization.supportedLocales.first(where: {
            preferred.caseInsensitiveCompare($0) == .orderedSame
        }) ?? NativeLocalization.supportedLocales.first(where: {
            $0.caseInsensitiveCompare(baseLanguage) == .orderedSame
        }) ?? "en"
    }

    var language: String {
        registrar.access(self, keyPath: \.language)
        lock.lock()
        defer { lock.unlock() }
        return selected
    }

    func setLanguage(_ value: String) {
        let baseLanguage = String(value.split(separator: "-").first ?? "en")
        let normalized = NativeLocalization.supportedLocales.first(where: {
            $0.caseInsensitiveCompare(value) == .orderedSame
        }) ?? NativeLocalization.supportedLocales.first(where: {
            $0.caseInsensitiveCompare(baseLanguage) == .orderedSame
        }) ?? "en"
        registrar.withMutation(of: self, keyPath: \.language) {
            lock.lock()
            selected = normalized
            lock.unlock()
        }
    }
}

func nativeString(_ value: String.LocalizationValue) -> String {
    NativeLocalization.string(value)
}
