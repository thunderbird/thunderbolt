/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Observation

enum NativePreferenceKey: String, CaseIterable, Sendable {
    case dataCollection = "data_collection"
    case triggersEnabled = "is_triggers_enabled"
    case experimentalFeatureTasks = "experimental_feature_tasks"
    case experimentalFeatureVoice = "experimental_feature_voice"
    case experimentalFeatureOtari = "experimental_feature_otari"
    case preferredName = "preferred_name"
    case locationName = "location_name"
    case locationNameDisplay = "location_name_display"
    case locationID = "location_id"
    case locationLatitude = "location_lat"
    case locationLongitude = "location_lng"
    case locationCountryCode = "location_country_code"
    case language
    case distanceUnit = "distance_unit"
    case temperatureUnit = "temperature_unit"
    case timeFormat = "time_format"
    case currency

    var defaultValue: String? {
        switch self {
        case .dataCollection: "true"
        case .triggersEnabled, .experimentalFeatureTasks, .experimentalFeatureVoice, .experimentalFeatureOtari: "false"
        default: nil
        }
    }
}

enum NativePreferencesError: Error, LocalizedError, Equatable {
    case invalidValue(NativePreferenceKey)

    var errorDescription: String? {
        switch self {
        case .invalidValue(let key): nativeString( "The value for \(key.rawValue) is not supported.")
        }
    }
}

/// Reads and writes preferences through the encrypted PowerSync settings table.
@MainActor
@Observable
final class NativePreferences {
    private(set) var values: [String: String] = [:]
    private(set) var error: String?

    @ObservationIgnored private let store: NativeSyncStore
    @ObservationIgnored private let userID: String
    @ObservationIgnored private var watcher: Task<Void, Never>?

    init(store: NativeSyncStore, userID: String) {
        self.store = store
        self.userID = userID
    }

    var tasksEnabled: Bool { boolValue(for: .experimentalFeatureTasks) }
    var customVoiceEnabled: Bool { boolValue(for: .experimentalFeatureVoice) }
    var otariEnabled: Bool { boolValue(for: .experimentalFeatureOtari) }
    var triggersEnabled: Bool { boolValue(for: .triggersEnabled) }

    func value(for key: NativePreferenceKey) -> String? {
        values[key.rawValue] ?? key.defaultValue
    }

    func boolValue(for key: NativePreferenceKey) -> Bool {
        value(for: key) == "true"
    }

    func start() {
        guard watcher == nil else { return }
        watcher = Task { [weak self, store, userID] in
            do {
                let stream = try await store.watch(table: "settings")
                for try await rows in stream {
                    guard let self, !Task.isCancelled else { return }
                    values = Self.decode(rows, userID: userID)
                }
            } catch is CancellationError {
            } catch {
                self?.error = error.localizedDescription
            }
        }
    }

    func stop() {
        watcher?.cancel()
        watcher = nil
        values = [:]
        error = nil
    }

    func refresh() async throws {
        let rows = try await store.readAll(table: "settings")
        values = Self.decode(rows, userID: userID)
    }

    func set(_ value: String?, for key: NativePreferenceKey) async throws {
        try Self.validate(value, for: key)
        try await write([
            key: value,
        ])
    }

    func set(_ enabled: Bool, for key: NativePreferenceKey) async throws {
        guard key == .dataCollection || key == .triggersEnabled || key == .experimentalFeatureTasks ||
                key == .experimentalFeatureVoice || key == .experimentalFeatureOtari else {
            throw NativePreferencesError.invalidValue(key)
        }
        try await set(enabled ? "true" : "false", for: key)
    }

    /// A manually entered place clears coordinates and localized labels so a
    /// stale geocoding result cannot keep driving regional defaults.
    func setLocationName(_ name: String?) async throws {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let value = trimmed.flatMap { $0.isEmpty ? nil : $0 }
        try await write([
            .locationName: value,
            .locationNameDisplay: nil,
            .locationID: nil,
            .locationLatitude: nil,
            .locationLongitude: nil,
            .locationCountryCode: nil,
        ])
    }

    private func write(_ updates: [NativePreferenceKey: String?]) async throws {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let mutations = updates.map { key, value in
            NativeSyncMutation(
                table: "settings",
                id: key.rawValue,
                values: [
                    "value": value.map(NativeSyncValue.text) ?? .null,
                    "updated_at": .text(timestamp),
                    "user_id": .text(userID),
                ]
            )
        }
        try await store.writeTransaction(mutations)
        for (key, value) in updates { values[key.rawValue] = value }
        error = nil
    }

    private static func decode(_ rows: [NativeSyncRow], userID: String) -> [String: String] {
        Dictionary(uniqueKeysWithValues: rows.compactMap { row in
            guard row.values["user_id"] == .text(userID),
                  case .text(let value)? = row.values["value"] else { return nil }
            return (row.id, value)
        })
    }

    private static func validate(_ value: String?, for key: NativePreferenceKey) throws {
        guard let value else { return }
        let valid: Bool
        switch key {
        case .dataCollection, .triggersEnabled, .experimentalFeatureTasks,
             .experimentalFeatureVoice, .experimentalFeatureOtari:
            valid = value == "true" || value == "false"
        case .language:
            valid = ["en", "de", "fr", "es", "pt-BR", "ja"].contains(value)
        case .distanceUnit:
            valid = ["metric", "imperial"].contains(value)
        case .temperatureUnit:
            valid = ["c", "f"].contains(value)
        case .timeFormat:
            valid = ["12h", "24h"].contains(value)
        case .currency:
            valid = value.count == 3 && value.utf8.allSatisfy { (65...90).contains($0) }
        case .preferredName, .locationName, .locationNameDisplay, .locationID,
             .locationLatitude, .locationLongitude, .locationCountryCode:
            valid = value.utf8.count <= 500
        }
        guard valid else { throw NativePreferencesError.invalidValue(key) }
    }
}
