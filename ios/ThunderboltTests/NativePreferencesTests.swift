/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import PowerSync
import XCTest
@testable import Thunderbolt

@MainActor
final class NativePreferencesTests: XCTestCase {
    func testSettingsUseEncryptedPowerSyncRowsAndRemainOwnerScoped() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-a", codec: PreferencesTestCodec(), trustedDevice: { true })
        let preferences = NativePreferences(store: store, userID: "user-a")

        try await preferences.set(false, for: .experimentalFeatureTasks)
        try await preferences.set("Ada", for: .preferredName)

        let rawValue = try await database.getOptional(
            sql: "SELECT value FROM settings WHERE id = ?", parameters: ["preferred_name"]
        ) { $0.getStringOptional(index: 0) }
        XCTAssertEqual(rawValue, "__enc:v2:Ada")
        XCTAssertEqual(preferences.value(for: .preferredName), "Ada")
        XCTAssertFalse(preferences.tasksEnabled)

        try await database.execute(
            sql: "INSERT INTO settings (id, value, user_id) VALUES (?, ?, ?)",
            parameters: ["language", "__enc:v2:ja", "user-b"]
        )
        try await preferences.refresh()
        XCTAssertNil(preferences.values[NativePreferenceKey.language.rawValue])
    }

    func testLocationChangeClearsStaleResolvedFieldsInSameStoreTransaction() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-a", codec: PreferencesTestCodec(), trustedDevice: { true })
        let preferences = NativePreferences(store: store, userID: "user-a")
        for (key, value) in [
            ("location_name_display", "Munich, Bavaria"), ("location_id", "open-meteo-1"),
            ("location_lat", "48.1"), ("location_lng", "11.5"), ("location_country_code", "DE"),
        ] {
            try await store.write(table: "settings", id: key, values: ["value": .text(value), "user_id": .text("user-a")])
        }

        try await preferences.setLocationName("  Portland  ")
        try await preferences.refresh()

        XCTAssertEqual(preferences.value(for: .locationName), "Portland")
        for key in [NativePreferenceKey.locationNameDisplay, .locationID, .locationLatitude, .locationLongitude, .locationCountryCode] {
            XCTAssertNil(preferences.value(for: key))
        }
    }

    func testPreferenceValuesAreValidatedBeforeWriting() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-a", codec: PreferencesTestCodec(), trustedDevice: { true })
        let preferences = NativePreferences(store: store, userID: "user-a")

        do {
            try await preferences.set("en-XA", for: .language)
            XCTFail("The CI pseudo-locale is not a user-selectable language.")
        } catch let error as NativePreferencesError {
            XCTAssertEqual(error, .invalidValue(.language))
        }
        let absent = try await database.getOptional(
            sql: "SELECT id FROM settings WHERE id = ?", parameters: ["language"]
        ) { $0.getStringOptional(index: 0) }
        XCTAssertNil(absent)
    }

    func testNativePreviewPreferenceKeysHaveTauriDefaultsAndPersistEncrypted() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-a", codec: PreferencesTestCodec(), trustedDevice: { true })
        let preferences = NativePreferences(store: store, userID: "user-a")

        XCTAssertFalse(preferences.customVoiceEnabled)
        XCTAssertFalse(preferences.otariEnabled)
        try await preferences.set(true, for: .experimentalFeatureVoice)
        try await preferences.set(true, for: .experimentalFeatureOtari)

        XCTAssertTrue(preferences.customVoiceEnabled)
        XCTAssertTrue(preferences.otariEnabled)
        let values = try await database.getAll(
            sql: "SELECT id, value FROM settings WHERE id IN (?, ?)",
            parameters: ["experimental_feature_voice", "experimental_feature_otari"]
        ) { (try $0.getString(index: 0), try $0.getString(index: 1)) }
        XCTAssertEqual(Set(values.map(\.0)), ["experimental_feature_voice", "experimental_feature_otari"])
        XCTAssertTrue(values.allSatisfy { $0.1 == "__enc:v2:true" })
    }
}

private struct PreferencesTestCodec: NativeSyncRowCodec {
    func isEncryptionConfigured() async throws -> Bool { true }
    func isReadyForSync() async throws -> Bool { true }
    func encode(_ plaintext: String, context: E2EEContext) async throws -> String { "__enc:v2:\(plaintext)" }
    func decode(_ encoded: String, context: E2EEContext?) async throws -> String {
        String(encoded.dropFirst("__enc:v2:".count))
    }
    func isEncryptedValue(_ value: String) -> Bool { value.hasPrefix("__enc:") }
    func isValidV2Ciphertext(_ value: String) -> Bool { value.hasPrefix("__enc:v2:") }
}
