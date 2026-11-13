/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
import PowerSync
@testable import Thunderbolt

final class NativeModelCatalogRepositoryTests: XCTestCase {
    func testFreshInstallReconcilesSharedModelsProfilesAndVersionMarker() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(), trustedDevice: { true })
        let repository = NativeModelCatalogRepository(store: store, ownerID: "user-1")

        let result = try await repository.reconcileDefaults(server: nil, initialSyncCompleted: false)
        XCTAssertEqual(result.version, 11)
        XCTAssertTrue(result.wroteChanges)
        XCTAssertTrue(result.droppedUnknownModelIDs.isEmpty)

        let models = try await store.readAll(table: "models")
        let modelHashPairs: [(String, String)] = models.compactMap { row -> (String, String)? in
            guard case .text(let value)? = row.values["default_hash"] else { return nil }
            return (row.id, value)
        }
        let modelHashes = Dictionary(uniqueKeysWithValues: modelHashPairs)
        XCTAssertEqual(modelHashes["019af08a-c27b-7074-8aac-95315d1ef3fd"], "-8jt8am")
        XCTAssertEqual(modelHashes["01a06dd7-67ee-75be-b957-2b746271c49d"], "-bs87m1")
        XCTAssertEqual(modelHashes["019e7580-2b0e-719c-a43f-d2b56e7f31b4"], "-mx717t")

        let profiles = try await store.readAll(table: "model_profiles")
        let profileHashPairs: [(String, String)] = profiles.compactMap { row -> (String, String)? in
            guard case .text(let value)? = row.values["default_hash"] else { return nil }
            return (row.id, value)
        }
        let profileHashes = Dictionary(uniqueKeysWithValues: profileHashPairs)
        XCTAssertEqual(profileHashes["019af08a-c27b-7074-8aac-95315d1ef3fd"], "-h76a67")
        XCTAssertEqual(profileHashes["01a06dd7-67ee-75be-b957-2b746271c49d"], "-fnc8qa")
        XCTAssertEqual(profileHashes["019e7580-2b0e-719c-a43f-d2b56e7f31b4"], "garvp9")

        let marker = try await store.read(table: "settings", id: "defaults_version.models")
        XCTAssertEqual(marker?.values["value"], .text("11"))
        let snapshot = try await repository.loadSnapshot()
        XCTAssertEqual(snapshot.models.count, 3)
        XCTAssertEqual(snapshot.profiles.count, 3)
        XCTAssertEqual(snapshot.models.first(where: { $0.id == NativeModelDefaults.defaultModelID })?.model, "deepseek-v4-1-flash")
    }

    func testPrivateThreadOnlyOffersModelsWithMatchingConfidentiality() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(), trustedDevice: { true })
        let repository = NativeModelCatalogRepository(store: store, ownerID: "user-1")
        try await store.writeTransaction([
            modelMutation(id: "standard", provider: "thunderbolt", confidential: 0),
            modelMutation(id: "private", provider: "tinfoil", confidential: 1),
            modelMutation(id: "disabled-private", provider: "tinfoil", confidential: 1, enabled: 0),
        ])

        let standard = try await repository.availableModels(forEncryptedThread: false)
        let privateModels = try await repository.availableModels(forEncryptedThread: true)
        XCTAssertEqual(standard.map(\.id), ["standard"])
        XCTAssertEqual(privateModels.map(\.id), ["private"])
        do {
            _ = try await repository.runtimeConfiguration(modelID: "private", threadID: "chat", isEncryptedThread: false)
            XCTFail("A confidential model must not be selected for a standard thread")
        } catch let error as NativeModelCatalogError {
            XCTAssertEqual(error, .modelUnavailable("private"))
        }
    }

    func testSelectedModelAndReasoningPreferenceUseExistingSyncedRows() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(), trustedDevice: { true })
        let repository = NativeModelCatalogRepository(store: store, ownerID: "user-1")
        try await store.write(table: "models", id: "model-1", values: [
            "provider": .text("thunderbolt"), "name": .text("Managed"), "model": .text("managed-model"),
            "is_system": .integer(1), "enabled": .integer(1), "is_confidential": .integer(0),
            "user_id": .text("user-1"),
        ])
        try await repository.selectModel("model-1", forEncryptedThread: false)
        try await repository.setReasoningEffort("high", modelID: "model-1")
        let runtime = try await repository.runtimeConfiguration(modelID: "model-1", threadID: "chat-1", isEncryptedThread: false)
        XCTAssertEqual(runtime.reasoningEffort, "high")
        let selected = try await repository.selectedModel(forEncryptedThread: false)
        XCTAssertEqual(selected.id, "model-1")

        do {
            try await repository.setReasoningEffort("unsupported", modelID: "model-1")
            XCTFail("Unknown reasoning choices must not be written to the shared row")
        } catch let error as NativeModelCatalogError {
            XCTAssertEqual(error, .invalidReasoningEffort)
        }
    }

    func testOverlappingOTAReportsUnprofiledModelsAndDoesNotStampTheVersion() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(), trustedDevice: { true })
        let repository = NativeModelCatalogRepository(store: store, ownerID: "user-1")
        _ = try await repository.reconcileDefaults(server: nil, initialSyncCompleted: true)
        let unknown = NativeModelDefault(
            id: "ota-without-profile", provider: "thunderbolt", name: "OTA model", model: "ota-model",
            url: nil, isSystem: 1, enabled: 1, toolUsage: 1, isConfidential: 0, startWithReasoning: 0,
            supportsParallelToolCalls: 1, contextWindow: nil, deletedAt: nil, defaultHash: nil,
            vendor: nil, description: nil, userID: nil
        )

        let result = try await repository.reconcileDefaults(
            server: NativeModelDefaultsPayload(version: 12, models: NativeModelDefaults.models + [unknown]),
            initialSyncCompleted: true
        )

        XCTAssertEqual(result.version, 12)
        XCTAssertEqual(result.droppedUnknownModelIDs, ["ota-without-profile"])
        XCTAssertFalse(result.wroteChanges)
        let unprofiledModel = try await store.read(table: "models", id: "ota-without-profile")
        let marker = try await store.read(table: "settings", id: "defaults_version.models")
        XCTAssertNil(unprofiledModel)
        XCTAssertEqual(marker?.values["value"], .text("11"))
    }

    func testDisjointOTAAndOlderMidSyncDefaultsDoNotOverwriteRowsOrAdvanceMarker() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(), trustedDevice: { true })
        let repository = NativeModelCatalogRepository(store: store, ownerID: "user-1")
        _ = try await repository.reconcileDefaults(server: nil, initialSyncCompleted: true)

        let invented = NativeModelDefault(
            id: "future-unbundled", provider: "thunderbolt", name: "Future", model: "future",
            url: nil, isSystem: 1, enabled: 1, toolUsage: 1, isConfidential: 0, startWithReasoning: 0,
            supportsParallelToolCalls: 1, contextWindow: nil, deletedAt: nil, defaultHash: nil,
            vendor: nil, description: nil, userID: nil
        )
        let rejected = try await repository.reconcileDefaults(
            server: NativeModelDefaultsPayload(version: 13, models: [invented]), initialSyncCompleted: true
        )
        XCTAssertEqual(rejected.version, 11)
        XCTAssertTrue(rejected.droppedUnknownModelIDs.isEmpty)

        var newer = NativeModelDefaults.models
        let first = try XCTUnwrap(newer.first)
        newer[0] = NativeModelDefault(
            id: first.id, provider: first.provider, name: "OTA-renamed", model: first.model, url: first.url,
            isSystem: first.isSystem, enabled: first.enabled, toolUsage: first.toolUsage,
            isConfidential: first.isConfidential, startWithReasoning: first.startWithReasoning,
            supportsParallelToolCalls: first.supportsParallelToolCalls, contextWindow: first.contextWindow,
            deletedAt: first.deletedAt, defaultHash: nil, vendor: first.vendor, description: first.description,
            userID: first.userID
        )
        let deferred = try await repository.reconcileDefaults(
            server: NativeModelDefaultsPayload(version: 12, models: newer), initialSyncCompleted: false
        )
        XCTAssertEqual(deferred.version, 12)
        XCTAssertFalse(deferred.wroteChanges)
        let preservedModel = try await store.read(table: "models", id: first.id)
        let preservedVersion = try await store.read(table: "settings", id: "defaults_version.models")
        XCTAssertEqual(preservedModel?.values["name"], .text(first.name))
        XCTAssertEqual(preservedVersion?.values["value"], .text("11"))
    }

    func testAddModelStoresCredentialOnlyInLocalSecretsAndCanBeEdited() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(), trustedDevice: { true })
        let repository = NativeModelCatalogRepository(store: store, ownerID: "user-1")

        let id = try await repository.addModel(
            provider: "openai", name: "My model", model: "custom-model", url: nil,
            apiKey: "local-test-secret", supportsTools: false, contextWindow: 32_000
        )
        let storedModel = try await store.read(table: "models", id: id)
        let storedSecret = try await store.read(table: "models_secrets", id: id)
        let modelRow = try XCTUnwrap(storedModel)
        let secretRow = try XCTUnwrap(storedSecret)
        XCTAssertEqual(modelRow.values["provider"], .text("openai"))
        XCTAssertEqual(modelRow.values["tool_usage"], .integer(0))
        XCTAssertEqual(modelRow.values["context_window"], .integer(32_000))
        XCTAssertFalse(modelRow.values.values.contains(.text("local-test-secret")))
        XCTAssertEqual(secretRow.values["api_key"], .text("local-test-secret"))

        try await repository.updateModel(
            id: id, name: "Renamed", model: "renamed-model", url: nil,
            enabled: false, supportsTools: true, supportsParallelToolCalls: false, contextWindow: nil
        )
        try await repository.setAPIKey("replacement-secret", modelID: id)
        let updatedModel = try await store.read(table: "models", id: id)
        let updatedSecretRow = try await store.read(table: "models_secrets", id: id)
        let updated = try XCTUnwrap(updatedModel)
        let updatedSecret = try XCTUnwrap(updatedSecretRow)
        XCTAssertEqual(updated.values["name"], .text("Renamed"))
        XCTAssertEqual(updated.values["enabled"], .integer(0))
        XCTAssertEqual(updatedSecret.values["api_key"], .text("replacement-secret"))
    }

    func testProfileIsSavedInExistingRowAndModelRemovalSoftDeletesAndScrubs() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(), trustedDevice: { true })
        let repository = NativeModelCatalogRepository(store: store, ownerID: "user-1")
        let id = try await repository.addModel(
            provider: "custom", name: "Gateway", model: "chat", url: "https://models.example/v1", apiKey: "key"
        )
        try await repository.saveProfile(modelID: id, draft: NativeModelProfileDraft(
            temperature: 0.4, maxSteps: 12, maxAttempts: 3, nudgeThreshold: 2,
            toolsOverride: "Use tools selectively.", providerOptionsJSON: "{\"reasoning\":{\"effort\":\"high\"}}"
        ))

        let storedProfile = try await store.read(table: "model_profiles", id: id)
        let profile = try XCTUnwrap(storedProfile)
        XCTAssertEqual(profile.values["temperature"], .real(0.4))
        XCTAssertEqual(profile.values["max_steps"], .integer(12))
        XCTAssertEqual(profile.values["provider_options"], .text("{\"reasoning\":{\"effort\":\"high\"}}"))
        do {
            try await repository.saveModelSettings(
                id: id, name: "Should roll back", model: "changed", url: "https://models.example/v1",
                enabled: false, supportsTools: false, supportsParallelToolCalls: false, contextWindow: nil,
                profile: NativeModelProfileDraft(
                    temperature: nil, maxSteps: nil, maxAttempts: nil, nudgeThreshold: nil,
                    toolsOverride: nil, providerOptionsJSON: "[]"
                ),
                apiKey: "replacement", clearAPIKey: false
            )
            XCTFail("Invalid profile settings must reject the whole save")
        } catch let error as NativeModelCatalogError {
            XCTAssertEqual(error, .invalidProfile)
        }
        let unchangedModel = try await store.read(table: "models", id: id)
        XCTAssertEqual(unchangedModel?.values["name"], .text("Gateway"))
        do {
            try await repository.saveProfile(modelID: id, draft: NativeModelProfileDraft(
                temperature: nil, maxSteps: nil, maxAttempts: nil, nudgeThreshold: nil,
                toolsOverride: nil, providerOptionsJSON: "[]"
            ))
            XCTFail("Provider options must remain an object")
        } catch let error as NativeModelCatalogError {
            XCTAssertEqual(error, .invalidProfile)
        }

        try await repository.softDeleteModel(id: id)
        let activeModels = try await store.readAll(table: "models")
        let activeProfiles = try await store.readAll(table: "model_profiles")
        XCTAssertFalse(activeModels.contains { $0.id == id })
        XCTAssertFalse(activeProfiles.contains { $0.id == id })
        let allModels = try await store.readAll(table: "models", includeDeleted: true)
        let allProfiles = try await store.readAll(table: "model_profiles", includeDeleted: true)
        let storedDeletedModel = allModels.first { $0.id == id }
        let storedDeletedProfile = allProfiles.first { $0.id == id }
        let storedCredential = try await store.read(table: "models_secrets", id: id)
        let deletedModel = try XCTUnwrap(storedDeletedModel)
        let deletedProfile = try XCTUnwrap(storedDeletedProfile)
        let secret = try XCTUnwrap(storedCredential)
        XCTAssertNotNil(deletedModel.values["deleted_at"])
        XCTAssertEqual(deletedModel.values["name"], .null)
        XCTAssertEqual(deletedModel.values["default_hash"], .null)
        XCTAssertNotNil(deletedProfile.values["deleted_at"])
        XCTAssertEqual(secret.values["api_key"], .null)
    }

    func testSystemModelCannotBeEditedOrRemovedThroughUserModelAPIs() async throws {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        let store = NativeSyncStore(database: database, ownerID: "user-1", codec: TestRowCodec(), trustedDevice: { true })
        let repository = NativeModelCatalogRepository(store: store, ownerID: "user-1")
        try await store.write(table: "models", id: "managed", values: [
            "provider": .text("thunderbolt"), "name": .text("Managed"), "model": .text("managed"),
            "is_system": .integer(1), "enabled": .integer(1), "user_id": .text("user-1"),
        ])
        do {
            try await repository.setModelEnabled(false, id: "managed")
            XCTFail("Managed models are read-only")
        } catch let error as NativeModelCatalogError {
            XCTAssertEqual(error, .systemModelIsReadOnly)
        }
        do {
            try await repository.softDeleteModel(id: "managed")
            XCTFail("Managed models cannot be removed")
        } catch let error as NativeModelCatalogError {
            XCTAssertEqual(error, .systemModelIsReadOnly)
        }
        let preservedManaged = try await store.read(table: "models", id: "managed")
        XCTAssertNotNil(preservedManaged)
    }

    private func modelMutation(
        id: String,
        provider: String,
        confidential: Int64,
        enabled: Int64 = 1
    ) -> NativeSyncMutation {
        NativeSyncMutation(table: "models", id: id, values: [
            "provider": .text(provider), "name": .text(id), "model": .text(id),
            "is_system": .integer(1), "enabled": .integer(enabled),
            "is_confidential": .integer(confidential), "user_id": .text("user-1"),
        ])
    }
}

private struct TestRowCodec: NativeSyncRowCodec {
    func isEncryptionConfigured() async throws -> Bool { true }
    func isReadyForSync() async throws -> Bool { true }
    func encode(_ plaintext: String, context: E2EEContext) async throws -> String { "__enc:v2:\(plaintext)" }
    func decode(_ encoded: String, context: E2EEContext?) async throws -> String { String(encoded.dropFirst("__enc:v2:".count)) }
    func isEncryptedValue(_ value: String) -> Bool { value.hasPrefix("__enc:") }
    func isValidV2Ciphertext(_ value: String) -> Bool { value.hasPrefix("__enc:v2:") }
}
