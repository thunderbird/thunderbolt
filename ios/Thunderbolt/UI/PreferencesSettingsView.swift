/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct PreferencesSettingsView: View {
    @Bindable var preferences: NativePreferences
    @Bindable private var devicePreferences = NativeDevicePreferences.shared
    @State private var preferredName = ""
    @State private var locationName = ""
    @State private var error: String?
    @State private var savedMessage: String?
    @State private var isSaving = false

    private let languages: [(String, String)] = [
        ("en", "English"), ("de", "Deutsch"), ("fr", "Français"),
        ("es", "Español"), ("pt-BR", "Português (Brasil)"), ("ja", "日本語"),
    ]

    var body: some View {
        TBSettingsPage(nativeString("Preferences")) {
            TBSettingsSection(nativeString("User Experience")) {
                HStack(spacing: 12) {
                    Text(nativeString("Theme"))
                        .tbFont(size: 16, weight: .regular)
                        .foregroundStyle(TBPalette.foreground)
                    Spacer(minLength: 8)
                    Picker(nativeString("Theme"), selection: Binding(
                        get: { devicePreferences.theme ?? "system" },
                        set: { devicePreferences.setTheme($0 == "system" ? nil : $0) }
                    )) {
                        Text(nativeString("System")).tag("system")
                        Text(nativeString("Light")).tag("light")
                        Text(nativeString("Dark")).tag("dark")
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("deviceTheme")
                }
                HStack(spacing: 12) {
                    Text(nativeString("External Links"))
                        .tbFont(size: 16, weight: .regular)
                        .foregroundStyle(TBPalette.foreground)
                    Spacer(minLength: 8)
                    Picker(nativeString("External Links"), selection: Binding(
                        get: { devicePreferences.externalLinkBehavior },
                        set: { devicePreferences.setExternalLinkBehavior($0) }
                    )) {
                        Text(nativeString("Ask")).tag("ask")
                        Text(nativeString("Browser")).tag("browser")
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("externalLinkBehavior")
                }
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(nativeString("Haptic Feedback"))
                            .tbFont(size: 16, weight: .regular)
                            .foregroundStyle(TBPalette.foreground)
                        Text(nativeString("Vibrate on tap"))
                            .tbFont(size: 13, weight: .regular)
                            .foregroundStyle(TBPalette.muted)
                    }
                    Spacer(minLength: 8)
                    Toggle(nativeString("Haptic Feedback"), isOn: Binding(
                        get: { devicePreferences.hapticsEnabled },
                        set: { devicePreferences.setHapticsEnabled($0) }
                    ))
                    .labelsHidden()
                    .accessibilityIdentifier("hapticsEnabled")
                }
            }

            TBSettingsSection(nativeString("Personalization"), footer: nativeString("Your name and location help Thunderbolt tailor responses.")) {
                VStack(alignment: .leading, spacing: 8) {
                    TBSettingsFieldLabel(title: "Preferred name")
                    TextField("Preferred name", text: $preferredName)
                        .textContentType(.nickname)
                        .submitLabel(.done)
                        .onSubmit { savePreferredName() }
                        .tbSettingsInputStyle()
                        .accessibilityIdentifier("preferredName")
                }
                VStack(alignment: .leading, spacing: 8) {
                    TBSettingsFieldLabel(title: "City or region")
                    TextField("City or region", text: $locationName)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.done)
                        .onSubmit { saveLocation() }
                        .tbSettingsInputStyle()
                        .accessibilityIdentifier("locationName")
                }
                Button("Save personalization", action: savePersonalization)
                    .buttonStyle(TBSettingsPrimaryButtonStyle())
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .disabled(isSaving)
                    .accessibilityIdentifier("savePersonalization")
            }

            TBSettingsSection(nativeString("Localization"), footer: nativeString("Automatic uses your location or device locale where the app supports it.")) {
                pickerRow("Language", key: .language, options: [("", "Automatic")] + languages)
                TBSettingsDivider()
                pickerRow("Distance", key: .distanceUnit, options: [("", "Automatic"), ("metric", "Metric"), ("imperial", "Imperial")])
                TBSettingsDivider()
                pickerRow("Temperature", key: .temperatureUnit, options: [("", "Automatic"), ("c", "Celsius"), ("f", "Fahrenheit")])
                TBSettingsDivider()
                pickerRow("Time format", key: .timeFormat, options: [("", "Automatic"), ("12h", "12-hour"), ("24h", "24-hour")])
                TBSettingsDivider()
                pickerRow("Currency", key: .currency, options: [("", "Automatic")] + currencyCodes.map { ($0, $0) })
            }

            TBSettingsSection(nativeString("Preview Features"), footer: nativeString("Preview features are experimental and sync with your account.")) {
                toggleRow("Tasks", key: .experimentalFeatureTasks, identifier: "experimentalTasks")
                toggleRow("Custom voice provider", key: .experimentalFeatureVoice, identifier: "experimentalVoice")
                toggleRow("Otari", key: .experimentalFeatureOtari, identifier: "experimentalOtari")
            }

            TBSettingsSection(nativeString("Privacy"), footer: nativeString("This preference is shared with your other devices.")) {
                toggleRow("Anonymous usage data", key: .dataCollection, identifier: "dataCollection")
            }

            if let savedMessage {
                Text(savedMessage)
                    .font(.system(size: 14))
                    .foregroundStyle(TBPalette.muted)
                    .accessibilityIdentifier("preferencesSaved")
            }
            if let error {
                Text(error)
                    .font(.system(size: 14))
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("preferencesError")
            }
            if let libraryError = preferences.error {
                Text(libraryError)
                    .font(.system(size: 14))
                    .foregroundStyle(.red)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task {
            try? await preferences.refresh()
            preferredName = preferences.value(for: .preferredName) ?? ""
            locationName = preferences.value(for: .locationName) ?? ""
        }
    }

    private var currencyCodes: [String] { Locale.commonISOCurrencyCodes.sorted() }

    private func pickerRow(_ title: String, key: NativePreferenceKey, options: [(String, String)]) -> some View {
        HStack(spacing: 12) {
            Text(title)
                .tbFont(size: 16, weight: .regular)
                .foregroundStyle(TBPalette.foreground)
            Spacer(minLength: 8)
            Picker(title, selection: preferenceBinding(key, default: "")) {
                ForEach(options, id: \.0) { value, label in Text(label).tag(value) }
            }
            .pickerStyle(.menu)
            .tbFont(size: 14, weight: .medium)
            .tint(TBPalette.brand)
            .accessibilityIdentifier("preference-\(key.rawValue)")
        }
        .frame(minHeight: 40)
    }

    private func toggleRow(_ title: String, key: NativePreferenceKey, identifier: String) -> some View {
        HStack(spacing: 12) {
            Text(title)
                .tbFont(size: 16, weight: .regular)
                .foregroundStyle(TBPalette.foreground)
            Spacer(minLength: 8)
            Toggle(title, isOn: boolBinding(key))
                .labelsHidden()
                .accessibilityIdentifier(identifier)
        }
        .frame(minHeight: 40)
    }

    private func preferenceBinding(_ key: NativePreferenceKey, default fallback: String) -> Binding<String> {
        Binding(
            get: { preferences.value(for: key) ?? fallback },
            set: { value in perform { try await preferences.set(value.isEmpty ? nil : value, for: key) } }
        )
    }

    private func boolBinding(_ key: NativePreferenceKey) -> Binding<Bool> {
        Binding(
            get: { preferences.boolValue(for: key) },
            set: { value in perform { try await preferences.set(value, for: key) } }
        )
    }

    private func savePreferredName() {
        perform { try await preferences.set(preferredName.isEmpty ? nil : preferredName, for: .preferredName) }
    }

    private func saveLocation() {
        perform { try await preferences.setLocationName(locationName) }
    }

    private func savePersonalization() {
        perform {
            try await preferences.set(preferredName.isEmpty ? nil : preferredName, for: .preferredName)
            try await preferences.setLocationName(locationName)
        }
    }

    @MainActor private func perform(_ operation: @escaping () async throws -> Void) {
        guard !isSaving else { return }
        isSaving = true
        error = nil
        savedMessage = nil
        Task {
            do {
                try await operation()
                savedMessage = nativeString("Preferences saved.")
            } catch {
                self.error = error.localizedDescription
            }
            isSaving = false
        }
    }
}
