/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

struct NativeModelReconcileResult: Sendable, Equatable {
    let version: Double
    let wroteChanges: Bool
    let droppedUnknownModelIDs: [String]
}

/// Reads and writes the existing PowerSync model, profile, settings, and local credential tables.
actor NativeModelCatalogRepository {
    private let store: NativeSyncStore
    private let ownerID: String

    init(store: NativeSyncStore, ownerID: String) {
        self.store = store
        self.ownerID = ownerID
    }

    /// Adds a user-owned model and its credential in one local transaction.
    func addModel(
        provider: String,
        name: String,
        model: String,
        url: String?,
        apiKey: String?,
        supportsTools: Bool = true,
        contextWindow: Int64? = nil
    ) async throws -> String {
        guard ["anthropic", "openai", "openrouter", "custom"].contains(provider) else {
            throw NativeModelCatalogError.invalidModel
        }
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty, !cleanModel.isEmpty else { throw NativeModelCatalogError.invalidModel }
        let cleanURL = try Self.validatedURL(url, provider: provider)
        let cleanKey = apiKey.flatMap { $0.isEmpty ? nil : $0 }
        guard cleanKey != nil else { throw NativeModelCatalogError.apiKeyRequired }
        guard contextWindow.map({ $0 > 0 }) ?? true else { throw NativeModelCatalogError.invalidModel }

        let id = UUID().uuidString.lowercased()
        var mutations = [NativeSyncMutation(table: "models", id: id, values: [
            "provider": .text(provider), "name": .text(cleanName), "model": .text(cleanModel),
            "url": Self.text(cleanURL), "provider_connection_id": .null,
            "is_system": .integer(0), "enabled": .integer(1),
            "tool_usage": .integer(supportsTools ? 1 : 0), "is_confidential": .integer(0),
            "start_with_reasoning": .integer(0), "supports_parallel_tool_calls": .integer(1),
            "context_window": Self.integer(contextWindow), "user_id": .text(ownerID),
        ])]
        if let cleanKey {
            mutations.append(NativeSyncMutation(table: "models_secrets", id: id, values: [
                "api_key": .text(cleanKey), "oauth_provider": .null, "provider_default": .null,
            ]))
        }
        try await store.writeTransaction(mutations)
        return id
    }

    /// Edits user-configurable fields without changing a model's provider or default identity.
    func updateModel(
        id: String,
        name: String,
        model: String,
        url: String?,
        enabled: Bool,
        supportsTools: Bool,
        supportsParallelToolCalls: Bool,
        contextWindow: Int64?
    ) async throws {
        let current = try await ownedModel(id)
        guard current.isSystem == 0 else { throw NativeModelCatalogError.systemModelIsReadOnly }
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty, !cleanModel.isEmpty else { throw NativeModelCatalogError.invalidModel }
        let cleanURL = try Self.validatedURL(url, provider: current.provider)
        guard contextWindow.map({ $0 > 0 }) ?? true else { throw NativeModelCatalogError.invalidModel }
        try await store.write(table: "models", id: id, values: [
            "name": .text(cleanName), "model": .text(cleanModel), "url": Self.text(cleanURL),
            "enabled": .integer(enabled ? 1 : 0), "tool_usage": .integer(supportsTools ? 1 : 0),
            "supports_parallel_tool_calls": .integer(supportsParallelToolCalls ? 1 : 0),
            "context_window": Self.integer(contextWindow),
        ])
    }

    func setModelEnabled(_ enabled: Bool, id: String) async throws {
        let model = try await ownedModel(id)
        guard model.isSystem == 0 else { throw NativeModelCatalogError.systemModelIsReadOnly }
        try await store.write(table: "models", id: id, values: ["enabled": .integer(enabled ? 1 : 0)])
    }

    /// Soft-deletes the model and its profile while scrubbing content and local credentials.
    func softDeleteModel(id: String) async throws {
        let model = try await ownedModel(id)
        guard model.isSystem == 0 else { throw NativeModelCatalogError.systemModelIsReadOnly }
        let now = Self.timestamp()
        let profile = try await store.read(table: "model_profiles", id: id)
        var mutations = [NativeSyncMutation(table: "models", id: id, values: [
            "provider_connection_id": .null, "provider": .null, "name": .null, "model": .null,
            "url": .null, "is_system": .null, "enabled": .null, "tool_usage": .null,
            "is_confidential": .null, "start_with_reasoning": .null, "reasoning_effort": .null,
            "supports_parallel_tool_calls": .null, "context_window": .null, "deleted_at": .text(now),
            "default_hash": .null, "vendor": .null, "description": .null,
        ])]
        if profile != nil, Self.string(profile, "deleted_at") == nil {
            mutations.append(NativeSyncMutation(table: "model_profiles", id: id, values: [
                "temperature": .null, "max_steps": .null, "max_attempts": .null, "nudge_threshold": .null,
                "use_system_message_mode_developer": .null, "tools_override": .null, "link_previews_override": .null,
                "chat_mode_addendum": .null, "search_mode_addendum": .null, "research_mode_addendum": .null,
                "citation_reinforcement_enabled": .null, "citation_reinforcement_prompt": .null,
                "nudge_final_step": .null, "nudge_preventive": .null,
                "nudge_retry": .null, "nudge_search_final_step": .null, "nudge_search_preventive": .null,
                "nudge_search_retry": .null, "provider_options": .null,
                "deleted_at": .text(now), "default_hash": .null,
            ]))
        }
        let prompts = try await store.readAll(table: "prompts")
            .filter { Self.string($0, "model_id") == id && Self.string($0, "user_id") == ownerID }
        let promptIDs = Set(prompts.map(\.id))
        if !promptIDs.isEmpty {
            for trigger in try await store.readAll(table: "triggers") where promptIDs.contains(Self.string(trigger, "prompt_id") ?? "") {
                mutations.append(NativeSyncMutation(table: "triggers", id: trigger.id, values: [
                    "trigger_type": .null, "trigger_time": .null, "prompt_id": .null,
                    "is_enabled": .null, "deleted_at": .text(now),
                ]))
            }
            for prompt in prompts {
                mutations.append(NativeSyncMutation(table: "prompts", id: prompt.id, values: [
                    "title": .null, "prompt": .null, "model_id": .null,
                    "deleted_at": .text(now), "default_hash": .null,
                ]))
            }
        }
        if try await store.read(table: "models_secrets", id: id) != nil {
            mutations.append(NativeSyncMutation(table: "models_secrets", id: id, values: [
                "api_key": .null, "oauth_provider": .null, "provider_default": .null,
            ]))
        }
        try await store.writeTransaction(mutations)
    }

    /// Writes the existing one-to-one synced profile row; no alternate profile schema is introduced.
    func saveProfile(modelID: String, draft: NativeModelProfileDraft) async throws {
        _ = try await ownedModel(modelID)
        try Self.validate(draft)
        let existing = try await store.read(table: "model_profiles", id: modelID)
        var values: [String: NativeSyncValue] = [
            "temperature": Self.real(draft.temperature), "max_steps": Self.integer(draft.maxSteps),
            "max_attempts": Self.integer(draft.maxAttempts), "nudge_threshold": Self.integer(draft.nudgeThreshold),
            "tools_override": Self.text(draft.toolsOverride),
            "provider_options": Self.text(draft.providerOptionsJSON), "deleted_at": .null,
        ]
        if existing == nil { values["user_id"] = .text(ownerID) }
        try await store.write(table: "model_profiles", id: modelID, values: values)
    }

    /// Saves the editable model, profile, and local key together as one SQLite transaction.
    func saveModelSettings(
        id: String,
        name: String,
        model: String,
        url: String?,
        enabled: Bool,
        supportsTools: Bool,
        supportsParallelToolCalls: Bool,
        contextWindow: Int64?,
        profile draft: NativeModelProfileDraft,
        apiKey: String?,
        clearAPIKey: Bool
    ) async throws {
        let current = try await ownedModel(id)
        guard current.isSystem == 0 else { throw NativeModelCatalogError.systemModelIsReadOnly }
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty, !cleanModel.isEmpty,
              contextWindow.map({ $0 > 0 }) ?? true else { throw NativeModelCatalogError.invalidModel }
        let cleanURL = try Self.validatedURL(url, provider: current.provider)
        try Self.validate(draft)

        let existingProfile = try await store.read(table: "model_profiles", id: id)
        let existingSecret = try await store.read(table: "models_secrets", id: id)
        var mutations = [NativeSyncMutation(table: "models", id: id, values: [
            "name": .text(cleanName), "model": .text(cleanModel), "url": Self.text(cleanURL),
            "enabled": .integer(enabled ? 1 : 0), "tool_usage": .integer(supportsTools ? 1 : 0),
            "supports_parallel_tool_calls": .integer(supportsParallelToolCalls ? 1 : 0),
            "context_window": Self.integer(contextWindow),
        ])]
        var profileValues: [String: NativeSyncValue] = Self.profileValues(draft)
        profileValues["deleted_at"] = .null
        if existingProfile == nil { profileValues["user_id"] = .text(ownerID) }
        mutations.append(NativeSyncMutation(table: "model_profiles", id: id, values: profileValues))

        if clearAPIKey || apiKey?.isEmpty == false {
            if existingSecret != nil || apiKey?.isEmpty == false {
                mutations.append(NativeSyncMutation(table: "models_secrets", id: id, values: [
                    "api_key": clearAPIKey ? .null : .text(apiKey ?? ""),
                    "oauth_provider": .null,
                    "provider_default": existingSecret?.values["provider_default"] ?? .null,
                ]))
            }
        }
        try await store.writeTransaction(mutations)
    }

    func clearAPIKey(modelID: String) async throws {
        try await setAPIKey(nil, modelID: modelID)
    }

    private func ownedModel(_ id: String) async throws -> NativeModel {
        let snapshot = try await loadSnapshot()
        guard let model = snapshot.models.first(where: { $0.id == id && $0.userID == ownerID }) else {
            throw NativeModelCatalogError.modelNotFound(id)
        }
        return model
    }

    private static func validatedURL(_ value: String?, provider: String) throws -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else {
            if provider == "custom" { throw NativeModelCatalogError.urlRequired }
            return nil
        }
        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              (scheme == "https" || (scheme == "http" && isLoopback(components.host))),
              components.host?.isEmpty == false,
              components.user == nil, components.password == nil else {
            throw NativeModelCatalogError.invalidModelURL
        }
        return components.url?.absoluteString
    }

    private static func isLoopback(_ host: String?) -> Bool {
        guard let host else { return false }
        let normalized = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        return ["localhost", "127.0.0.1", "::1"].contains(normalized)
    }

    private static func validJSONObject(_ value: String?) -> Bool {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return true }
        guard let data = value.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              object is [String: Any] else { return false }
        return true
    }

    private static func validate(_ draft: NativeModelProfileDraft) throws {
        guard draft.temperature.map({ $0.isFinite && (-100 ... 100).contains($0) }) ?? true,
              draft.maxSteps.map({ (1 ... 1000).contains($0) }) ?? true,
              draft.maxAttempts.map({ (1 ... 100).contains($0) }) ?? true,
              draft.nudgeThreshold.map({ (1 ... 1000).contains($0) }) ?? true,
              validJSONObject(draft.providerOptionsJSON) else {
            throw NativeModelCatalogError.invalidProfile
        }
    }

    private static func profileValues(_ draft: NativeModelProfileDraft) -> [String: NativeSyncValue] {
        [
            "temperature": real(draft.temperature), "max_steps": integer(draft.maxSteps),
            "max_attempts": integer(draft.maxAttempts), "nudge_threshold": integer(draft.nudgeThreshold),
            "tools_override": text(draft.toolsOverride), "provider_options": text(draft.providerOptionsJSON),
        ]
    }

    func loadSnapshot() async throws -> NativeModelCatalogSnapshot {
        async let modelRows = store.readAll(table: "models")
        async let profileRows = store.readAll(table: "model_profiles")
        async let settingRows = store.readAll(table: "settings")
        async let secretRows = store.readAll(table: "models_secrets")
        async let connectionRows = store.readAll(table: "provider_connections")
        async let connectionSecretRows = store.readAll(table: "provider_connection_secrets")
        async let integrationSecretRows = store.readAll(table: "integrations_secrets")

        let (models, profiles, settings, secrets, connections, connectionSecrets, integrationSecrets) = try await (
            modelRows, profileRows, settingRows, secretRows, connectionRows, connectionSecretRows, integrationSecretRows
        )
        let integrationSecretsByProvider = Dictionary(uniqueKeysWithValues: integrationSecrets.map { ($0.id, $0) })
        let settingsByKey = Dictionary(uniqueKeysWithValues: settings.compactMap { row in
            Self.string(row, "value").map { (row.id, $0) }
        })
        let secretsByID = Dictionary(uniqueKeysWithValues: secrets.map { ($0.id, $0) })
        let connectionsByID = Dictionary(uniqueKeysWithValues: connections.map { ($0.id, $0) })
        let connectionSecretsByID = Dictionary(uniqueKeysWithValues: connectionSecrets.map { ($0.id, $0) })

        let mappedModels = models
            .filter { Self.string($0, "user_id") == ownerID && Self.string($0, "deleted_at") == nil }
            .compactMap { row in
                Self.mapModel(
                    row,
                    secret: secretsByID[row.id],
                    connections: connectionsByID,
                    connectionSecrets: connectionSecretsByID,
                    integrationSecrets: integrationSecretsByProvider
                )
            }
            .sorted { lhs, rhs in
                if (lhs.isSystem == 1) != (rhs.isSystem == 1) { return lhs.isSystem == 1 }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }

        let profilePairs: [(String, NativeModelProfile)] = profiles.compactMap { row in
            guard Self.string(row, "user_id") == ownerID,
                  Self.string(row, "deleted_at") == nil,
                  let profile = Self.mapProfile(row) else { return nil }
            return (profile.modelID, profile)
        }
        let mappedProfiles = Dictionary(uniqueKeysWithValues: profilePairs)
        let selectedModelID = settingsByKey["selected_model"]
        return NativeModelCatalogSnapshot(
            models: mappedModels,
            profiles: mappedProfiles,
            settings: settingsByKey,
            selectedModelID: selectedModelID
        )
    }

    /// Returns enabled, configured models that preserve the thread's encryption mode.
    func availableModels(forEncryptedThread isEncrypted: Bool) async throws -> [NativeModel] {
        let snapshot = try await loadSnapshot()
        let showOtari = snapshot.settings["experimental_feature_otari"] == "true"
        return snapshot.models.filter { model in
            model.isConfigured && model.isConfidential == (isEncrypted ? 1 : 0) &&
                (model.provider != "otari" || showOtari)
        }
    }

    /// Resolves the model and synced runtime profile at the send boundary.
    func runtimeConfiguration(
        modelID: String,
        threadID: String,
        isEncryptedThread: Bool
    ) async throws -> NativeModelRuntimeConfiguration {
        let snapshot = try await loadSnapshot()
        guard let model = snapshot.models.first(where: { $0.id == modelID }) else {
            throw NativeModelCatalogError.modelNotFound(modelID)
        }
        let showOtari = snapshot.settings["experimental_feature_otari"] == "true"
        guard model.isConfigured, model.provider != "otari" || showOtari,
              model.isConfidential == (isEncryptedThread ? 1 : 0) else {
            throw NativeModelCatalogError.modelUnavailable(modelID)
        }
        let legacyKey = "chat-reasoning-effort:\(threadID):\(modelID)"
        let savedEffort = model.reasoningEffort ?? snapshot.settings[legacyKey]
        let effort = savedEffort.flatMap { Self.isReasoningEffort($0) ? $0 : nil }
        return NativeModelRuntimeConfiguration(
            model: model,
            profile: snapshot.profiles[modelID],
            reasoningEffort: effort,
            isConfidentialThread: isEncryptedThread
        )
    }

    func selectedModel(forEncryptedThread isEncrypted: Bool) async throws -> NativeModel {
        let snapshot = try await loadSnapshot()
        let available = try await availableModels(forEncryptedThread: isEncrypted)
        if let selectedID = snapshot.selectedModelID, let selected = available.first(where: { $0.id == selectedID }) {
            return selected
        }
        if let bundledDefault = available.first(where: { $0.id == NativeModelDefaults.defaultModelID }) {
            return bundledDefault
        }
        guard let fallback = available.first(where: { $0.isSystem == 1 }) else {
            throw NativeModelCatalogError.modelUnavailable(snapshot.selectedModelID ?? NativeModelDefaults.defaultModelID)
        }
        return fallback
    }

    func selectModel(_ modelID: String, forEncryptedThread isEncrypted: Bool) async throws {
        guard try await availableModels(forEncryptedThread: isEncrypted).contains(where: { $0.id == modelID }) else {
            throw NativeModelCatalogError.modelUnavailable(modelID)
        }
        let snapshot = try await loadSnapshot()
        let existing = snapshot.settings["selected_model"]
        let values: [String: NativeSyncValue] = existing == nil
            ? ["value": .text(modelID), "user_id": .text(ownerID)]
            : ["value": .text(modelID)]
        // The store uses INSERT when id is absent and UPDATE when it exists; no SQLite UPSERT is used.
        try await store.write(table: "settings", id: "selected_model", values: values)
    }

    func setReasoningEffort(_ effort: String?, modelID: String) async throws {
        if let effort, !Self.isReasoningEffort(effort) { throw NativeModelCatalogError.invalidReasoningEffort }
        guard try await loadSnapshot().models.contains(where: { $0.id == modelID }) else {
            throw NativeModelCatalogError.modelNotFound(modelID)
        }
        try await store.write(
            table: "models",
            id: modelID,
            values: ["reasoning_effort": effort.map(NativeSyncValue.text) ?? .null]
        )
    }

    func setAPIKey(_ apiKey: String?, modelID: String) async throws {
        let value: NativeSyncValue
        if let apiKey, !apiKey.isEmpty { value = .text(apiKey) } else { value = .null }
        let snapshot = try await loadSnapshot()
        let hasRow = snapshot.models.contains(where: { $0.id == modelID })
        guard hasRow else { throw NativeModelCatalogError.modelNotFound(modelID) }
        let localSecret = try await store.read(table: "models_secrets", id: modelID)
        if localSecret == nil, case .null = value { return }
        try await store.write(
            table: "models_secrets",
            id: modelID,
            values: localSecret == nil
                ? ["api_key": value, "oauth_provider": .null, "provider_default": .null]
                : ["api_key": value, "oauth_provider": .null]
        )
    }

    /// Applies the shared monotonic models version gate and paired default profile reconciliation.
    func reconcileDefaults(
        server: NativeModelDefaultsPayload?,
        initialSyncCompleted: Bool
    ) async throws -> NativeModelReconcileResult {
        let picked = Self.pickDefaults(server)
        let knownProfileIDs = Set(NativeModelDefaults.profiles.map(\.modelID))
        let applicableModels = picked.models.filter { knownProfileIDs.contains($0.id) }
        let currentIDs = Set(picked.models.map(\.id))
        let droppedIDs = picked.models.filter { !knownProfileIDs.contains($0.id) }.map(\.id)
        let allRows = try await store.readAll(table: "models", includeDeleted: true)
            .filter { Self.string($0, "user_id") == ownerID }
        let profileRows = try await store.readAll(table: "model_profiles", includeDeleted: true)
            .filter { Self.string($0, "user_id") == ownerID }
        let settingsRows = try await store.readAll(table: "settings", includeDeleted: true)
        let markerRow = settingsRows.first(where: { $0.id == "defaults_version.models" })
        let storedVersion = Self.string(markerRow, "value").flatMap(Double.init)
        let hasAnyModelRow = !allRows.isEmpty
        let canOverwrite = picked.version > (storedVersion ?? -.infinity) && (!hasAnyModelRow || initialSyncCompleted)
        let canResurrect = initialSyncCompleted
        let now = Self.timestamp()
        var mutations: [NativeSyncMutation] = []
        var modelsMutated = false
        var modelsAtTarget = true
        var profilesMutated = false
        var profilesAtTarget = true

        if canOverwrite {
            for row in allRows where Self.integer(row, "is_system") == 1 &&
                Self.string(row, "deleted_at") == nil && !currentIDs.contains(row.id) &&
                Self.string(row, "default_hash") != nil {
                mutations.append(NativeSyncMutation(table: "models", id: row.id, values: ["deleted_at": .text(now)]))
            }
        }

        let modelsByID = Dictionary(uniqueKeysWithValues: allRows.map { ($0.id, $0) })
        for item in applicableModels {
            guard let existing = modelsByID[item.id] else {
                guard canOverwrite else { modelsAtTarget = false; continue }
                mutations.append(NativeSyncMutation(
                    table: "models", id: item.id, values: Self.modelValues(item, ownerID: ownerID, hash: Self.modelHash(item))
                ))
                modelsMutated = true
                continue
            }

            if Self.string(existing, "deleted_at") != nil,
               let oldHash = Self.string(existing, "default_hash"),
               oldHash == Self.modelHash(Self.defaultModel(from: existing).withDeletedAt(nil)) {
                if canResurrect {
                    mutations.append(NativeSyncMutation(table: "models", id: existing.id, values: ["deleted_at": .null]))
                    modelsMutated = true
                } else { modelsAtTarget = false }
                continue
            }
            guard canOverwrite else { modelsAtTarget = false; continue }
            let current = Self.defaultModel(from: existing)
            let existingHash = Self.string(existing, "default_hash")
            let effective = item.replacingIdentity(provider: current.provider, isConfidential: current.isConfidential)
            let effectiveHash = Self.modelHash(effective)
            if existingHash == nil {
                mutations.append(NativeSyncMutation(table: "models", id: existing.id, values: ["default_hash": .text(Self.modelHash(item))]))
                modelsMutated = true
                continue
            }
            let currentHash = Self.modelHash(current)
            let metadataChanged = Self.string(existing, "vendor") != item.vendor || Self.string(existing, "description") != item.description
            if currentHash != existingHash && currentHash != effectiveHash {
                modelsAtTarget = false
                continue
            }
            if existingHash == effectiveHash && !metadataChanged { continue }
            mutations.append(NativeSyncMutation(
                table: "models", id: existing.id,
                values: Self.modelValues(effective, ownerID: ownerID, hash: effectiveHash)
            ))
            modelsMutated = true
        }

        let pendingModelDeletes = Set(mutations.compactMap { mutation -> String? in
            guard mutation.table == "models", case .some(.text(_)) = mutation.values["deleted_at"] else { return nil }
            return mutation.id
        })
        let pendingModelResurrections = Set(mutations.compactMap { mutation -> String? in
            guard mutation.table == "models", case .some(.null) = mutation.values["deleted_at"] else { return nil }
            return mutation.id
        })
        let activeModelIDs = Set(allRows.compactMap { row -> String? in
            guard !pendingModelDeletes.contains(row.id),
                  Self.string(row, "deleted_at") == nil || pendingModelResurrections.contains(row.id) else { return nil }
            return row.id
        })
        let profileDefaults = NativeModelDefaults.profiles.filter { profile in applicableModels.contains(where: { $0.id == profile.modelID }) }
        if initialSyncCompleted {
            for row in profileRows where Self.string(row, "deleted_at") == nil &&
                !activeModelIDs.contains(row.id) && Self.string(row, "default_hash") != nil {
                mutations.append(NativeSyncMutation(table: "model_profiles", id: row.id, values: ["deleted_at": .text(now)]))
            }
        }
        let profilesByID = Dictionary(uniqueKeysWithValues: profileRows.map { ($0.id, $0) })
        for item in profileDefaults {
            guard let existing = profilesByID[item.modelID] else {
                // Profiles are 1:1 with models. Missing bundled profiles may be repaired while the model gate is closed.
                mutations.append(NativeSyncMutation(
                    table: "model_profiles", id: item.modelID,
                    values: Self.profileValues(item, ownerID: ownerID, hash: Self.profileHash(item))
                ))
                profilesMutated = true
                continue
            }
            if Self.string(existing, "deleted_at") != nil,
               let oldHash = Self.string(existing, "default_hash"),
               oldHash == Self.profileHash(Self.profile(from: existing).withDeletedAt(nil)) {
                if canResurrect {
                    mutations.append(NativeSyncMutation(table: "model_profiles", id: existing.id, values: ["deleted_at": .null]))
                    profilesMutated = true
                } else { profilesAtTarget = false }
                continue
            }
            guard canOverwrite else { profilesAtTarget = false; continue }
            let current = Self.profile(from: existing)
            let existingHash = Self.string(existing, "default_hash")
            if existingHash == nil {
                mutations.append(NativeSyncMutation(table: "model_profiles", id: existing.id, values: ["default_hash": .text(Self.profileHash(item))]))
                profilesMutated = true
                continue
            }
            let currentHash = Self.profileHash(current)
            let desiredHash = Self.profileHash(item)
            if currentHash != existingHash && currentHash != desiredHash {
                profilesAtTarget = false
                continue
            }
            if existingHash == desiredHash { continue }
            mutations.append(NativeSyncMutation(
                table: "model_profiles", id: item.modelID,
                values: Self.profileValues(item, ownerID: ownerID, hash: desiredHash)
            ))
            profilesMutated = true
        }

        let bothAtTarget = modelsAtTarget && profilesAtTarget
        if canOverwrite && (modelsMutated || profilesMutated || bothAtTarget) && droppedIDs.isEmpty {
            let versionString = picked.version.rounded(.towardZero) == picked.version
                ? String(Int64(picked.version))
                : String(picked.version)
            let markerValues: [String: NativeSyncValue] = ["value": .text(versionString), "user_id": .text(ownerID)]
            mutations.append(NativeSyncMutation(
                table: "settings", id: "defaults_version.models",
                values: markerRow == nil ? markerValues : ["value": .text(versionString)]
            ))
        }
        if !mutations.isEmpty { try await store.writeTransaction(mutations) }
        return NativeModelReconcileResult(version: picked.version, wroteChanges: !mutations.isEmpty, droppedUnknownModelIDs: droppedIDs)
    }

    private static func pickDefaults(_ server: NativeModelDefaultsPayload?) -> NativeModelDefaultsPayload {
        guard let server, server.version.isFinite, server.version > NativeModelDefaults.version,
              !server.models.isEmpty,
              server.models.contains(where: { item in NativeModelDefaults.models.contains(where: { $0.id == item.id }) }) else {
            return NativeModelDefaultsPayload(version: NativeModelDefaults.version, models: NativeModelDefaults.models)
        }
        return server
    }

    private static func mapModel(
        _ row: NativeSyncRow,
        secret: NativeSyncRow?,
        connections: [String: NativeSyncRow],
        connectionSecrets: [String: NativeSyncRow],
        integrationSecrets: [String: NativeSyncRow]
    ) -> NativeModel? {
        guard let provider = string(row, "provider"), let name = string(row, "name"), let model = string(row, "model") else { return nil }
        let connectionID = string(row, "provider_connection_id")
        let secretAPIKey = string(secret, "api_key")
        let secretOAuthProvider = string(secret, "oauth_provider")
        let integrationSecret = secretOAuthProvider.flatMap { integrationSecrets[$0] }
        let integrationCredentials = string(integrationSecret, "credentials").flatMap(parseJSONObject)
        let connection = connectionID.flatMap { connections[$0] }
        let connectionSecret = connectionID.flatMap { connectionSecrets[$0] }
        let connectionProvider = string(connection, "provider")
        let authMethod = string(connection, "auth_method")
        let remoteURL = connectionID == nil ? string(row, "url") : string(connection, "url")
        let remoteCredentials = string(connectionSecret, "credentials").flatMap(parseJSONObject)
        let binding = string(connectionSecret, "binding")
        let expectedBinding = connection.flatMap { expectedCredentialBinding($0) }
        let bound = connectionID == nil || (binding != nil && binding == expectedBinding)
        let connectionActive = connectionID == nil || (
            connection != nil && connectionProvider == provider && integer(connection, "enabled") == 1 &&
                string(connection, "deleted_at") == nil && bound && credentialsAreConnected(remoteCredentials, provider: provider, authMethod: authMethod)
        )
        let linkedAPIKey = remoteCredentials?["apiKey"] as? String ?? remoteCredentials?["access_token"] as? String
        let integrationToken = integrationCredentials?["access_token"] as? String ?? integrationCredentials?["apiKey"] as? String
        let integrationReady = secretOAuthProvider == nil || (
            integrationSecret != nil && integer(integrationSecret, "enabled") == 1 &&
                integrationCredentials?["reauth_required"] as? Bool != true && integrationToken?.isEmpty == false
        )
        let apiKey = connectionID == nil
            ? (secretOAuthProvider == nil ? secretAPIKey : (integrationReady ? integrationToken : nil))
            : (connectionActive ? linkedAPIKey : nil)
        let oauthProvider = connectionID == nil ? secretOAuthProvider : (provider == "tinfoil" && authMethod == "oauth" ? "tinfoil" : nil)
        return NativeModel(
            id: row.id, provider: provider, name: name, model: model, url: remoteURL,
            providerConnectionID: connectionID, connectionAuthMethod: authMethod,
            isSystem: integer(row, "is_system") ?? 0, enabled: integer(row, "enabled") ?? 1,
            toolUsage: integer(row, "tool_usage") ?? 1, isConfidential: integer(row, "is_confidential") ?? 0,
            startWithReasoning: integer(row, "start_with_reasoning") ?? 0,
            reasoningEffort: string(row, "reasoning_effort"),
            supportsParallelToolCalls: integer(row, "supports_parallel_tool_calls") ?? 1,
            contextWindow: integer(row, "context_window"), deletedAt: string(row, "deleted_at"),
            defaultHash: string(row, "default_hash"), vendor: string(row, "vendor"),
            description: string(row, "description"), userID: string(row, "user_id"),
            apiKey: apiKey, oauthProvider: oauthProvider, providerDefault: integer(secret, "provider_default"),
            connectionName: string(connection, "name"), connectionReady: connectionActive && integrationReady
        )
    }

    private static func mapProfile(_ row: NativeSyncRow) -> NativeModelProfile? {
        NativeModelProfile(
            modelID: row.id, temperature: real(row, "temperature"), maxSteps: integer(row, "max_steps"),
            maxAttempts: integer(row, "max_attempts"), nudgeThreshold: integer(row, "nudge_threshold"),
            useSystemMessageModeDeveloper: integer(row, "use_system_message_mode_developer") ?? 0,
            toolsOverride: string(row, "tools_override"), linkPreviewsOverride: string(row, "link_previews_override"),
            chatModeAddendum: string(row, "chat_mode_addendum"), searchModeAddendum: string(row, "search_mode_addendum"),
            researchModeAddendum: string(row, "research_mode_addendum"),
            citationReinforcementEnabled: integer(row, "citation_reinforcement_enabled") ?? 0,
            citationReinforcementPrompt: string(row, "citation_reinforcement_prompt"),
            nudgeFinalStep: string(row, "nudge_final_step"), nudgePreventive: string(row, "nudge_preventive"),
            nudgeRetry: string(row, "nudge_retry"), nudgeSearchFinalStep: string(row, "nudge_search_final_step"),
            nudgeSearchPreventive: string(row, "nudge_search_preventive"), nudgeSearchRetry: string(row, "nudge_search_retry"),
            providerOptionsJSON: string(row, "provider_options"), defaultHash: string(row, "default_hash"),
            deletedAt: string(row, "deleted_at"), userID: string(row, "user_id")
        )
    }

    private static func credentialsAreConnected(_ credentials: [String: Any]?, provider: String, authMethod: String?) -> Bool {
        guard let credentials, (credentials["reauth_required"] as? Bool != true) else { return false }
        if provider == "custom" { return true }
        let apiKey = credentials["apiKey"] as? String ?? credentials["access_token"] as? String ?? ""
        guard !apiKey.isEmpty else { return false }
        if provider == "openai", authMethod == "oauth" {
            guard let oauth = credentials["oauth"] as? [String: Any],
                  let subject = oauth["subject"] as? String, !subject.isEmpty,
                  let scope = oauth["scope"] as? String,
                  !scope.split(separator: " ").contains("chatgpt.tokens.use.direct") else { return false }
        }
        guard provider == "tinfoil", authMethod == "oauth" else { return true }
        if let refreshToken = credentials["refresh_token"] as? String, !refreshToken.isEmpty { return true }
        let expiresAt = (credentials["expires_at"] as? NSNumber)?.doubleValue ?? 0
        return expiresAt > Date().timeIntervalSince1970 * 1000 + 60_000
    }

    private static func expectedCredentialBinding(_ connection: NativeSyncRow) -> String? {
        guard let provider = string(connection, "provider"), let authMethod = string(connection, "auth_method") else { return nil }
        let url = string(connection, "url")
        let array: [Any] = [provider, authMethod, url as Any? ?? NSNull()]
        guard let data = try? JSONSerialization.data(withJSONObject: array, options: [.fragmentsAllowed]),
              let string = String(data: data, encoding: .utf8) else { return nil }
        return string
    }

    private static func parseJSONObject(_ value: String) -> [String: Any]? {
        guard let data = value.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else { return nil }
        return dictionary
    }

    private static func isReasoningEffort(_ value: String) -> Bool {
        ["none", "minimal", "low", "medium", "high", "xhigh", "max"].contains(value)
    }

    private static func modelValues(_ item: NativeModelDefault, ownerID: String, hash: String) -> [String: NativeSyncValue] {
        [
            "provider": .text(item.provider), "name": .text(item.name), "model": .text(item.model),
            "url": text(item.url), "provider_connection_id": .null,
            "is_system": .integer(item.isSystem ?? 0), "enabled": .integer(item.enabled),
            "tool_usage": .integer(item.toolUsage), "is_confidential": .integer(item.isConfidential),
            "start_with_reasoning": .integer(item.startWithReasoning), "reasoning_effort": .null,
            "supports_parallel_tool_calls": .integer(item.supportsParallelToolCalls),
            "context_window": integer(item.contextWindow), "deleted_at": text(item.deletedAt),
            "default_hash": .text(hash), "vendor": text(item.vendor), "description": text(item.description),
            "user_id": .text(ownerID),
        ]
    }

    private static func profileValues(_ item: NativeModelProfileDefault, ownerID: String, hash: String) -> [String: NativeSyncValue] {
        [
            "temperature": real(item.temperature), "max_steps": integer(item.maxSteps),
            "max_attempts": integer(item.maxAttempts), "nudge_threshold": integer(item.nudgeThreshold),
            "use_system_message_mode_developer": .integer(item.useSystemMessageModeDeveloper),
            "tools_override": text(item.toolsOverride), "link_previews_override": text(item.linkPreviewsOverride),
            "chat_mode_addendum": text(item.chatModeAddendum), "search_mode_addendum": text(item.searchModeAddendum),
            "research_mode_addendum": text(item.researchModeAddendum),
            "citation_reinforcement_enabled": .integer(item.citationReinforcementEnabled),
            "citation_reinforcement_prompt": text(item.citationReinforcementPrompt),
            "nudge_final_step": text(item.nudgeFinalStep), "nudge_preventive": text(item.nudgePreventive),
            "nudge_retry": text(item.nudgeRetry), "nudge_search_final_step": text(item.nudgeSearchFinalStep),
            "nudge_search_preventive": text(item.nudgeSearchPreventive), "nudge_search_retry": text(item.nudgeSearchRetry),
            "provider_options": text(item.providerOptionsJSON), "default_hash": .text(hash),
            "deleted_at": .null, "user_id": .text(ownerID),
        ]
    }

    private static func modelHash(_ item: NativeModelDefault) -> String {
        hashValues([
            item.name, item.provider, item.model, item.url, item.isSystem, item.enabled,
            item.toolUsage, item.isConfidential, item.startWithReasoning, item.supportsParallelToolCalls,
            item.contextWindow, item.deletedAt,
        ])
    }

    private static func profileHash(_ item: NativeModelProfileDefault) -> String {
        hashValues([
            item.temperature, item.maxSteps, item.maxAttempts, item.nudgeThreshold,
            item.useSystemMessageModeDeveloper, item.toolsOverride, item.linkPreviewsOverride,
            item.chatModeAddendum, item.searchModeAddendum, item.researchModeAddendum,
            item.citationReinforcementEnabled, item.citationReinforcementPrompt,
            item.nudgeFinalStep, item.nudgePreventive, item.nudgeRetry,
            item.nudgeSearchFinalStep, item.nudgeSearchPreventive, item.nudgeSearchRetry,
            item.providerOptionsJSON, item.deletedAt,
        ])
    }

    private static func profileHash(_ item: NativeModelProfile) -> String {
        hashValues([
            item.temperature, item.maxSteps, item.maxAttempts, item.nudgeThreshold,
            item.useSystemMessageModeDeveloper, item.toolsOverride, item.linkPreviewsOverride,
            item.chatModeAddendum, item.searchModeAddendum, item.researchModeAddendum,
            item.citationReinforcementEnabled, item.citationReinforcementPrompt,
            item.nudgeFinalStep, item.nudgePreventive, item.nudgeRetry,
            item.nudgeSearchFinalStep, item.nudgeSearchPreventive, item.nudgeSearchRetry,
            item.providerOptionsJSON, item.deletedAt,
        ])
    }

    private static func profile(from row: NativeSyncRow, deletedAt: String? = nil) -> NativeModelProfileDefault {
        NativeModelProfileDefault(
            modelID: row.id, temperature: real(row, "temperature"), maxSteps: integer(row, "max_steps"),
            maxAttempts: integer(row, "max_attempts"), nudgeThreshold: integer(row, "nudge_threshold"),
            useSystemMessageModeDeveloper: integer(row, "use_system_message_mode_developer") ?? 0,
            toolsOverride: string(row, "tools_override"), linkPreviewsOverride: string(row, "link_previews_override"),
            chatModeAddendum: string(row, "chat_mode_addendum"), searchModeAddendum: string(row, "search_mode_addendum"),
            researchModeAddendum: string(row, "research_mode_addendum"),
            citationReinforcementEnabled: integer(row, "citation_reinforcement_enabled") ?? 0,
            citationReinforcementPrompt: string(row, "citation_reinforcement_prompt"),
            nudgeFinalStep: string(row, "nudge_final_step"), nudgePreventive: string(row, "nudge_preventive"),
            nudgeRetry: string(row, "nudge_retry"), nudgeSearchFinalStep: string(row, "nudge_search_final_step"),
            nudgeSearchPreventive: string(row, "nudge_search_preventive"), nudgeSearchRetry: string(row, "nudge_search_retry"),
            providerOptionsJSON: string(row, "provider_options"),
            deletedAt: deletedAt ?? string(row, "deleted_at")
        )
    }

    private static func defaultModel(from row: NativeSyncRow, deletedAt: String? = nil) -> NativeModelDefault {
        NativeModelDefault(
            id: row.id, provider: string(row, "provider") ?? "", name: string(row, "name") ?? "",
            model: string(row, "model") ?? "", url: string(row, "url"), isSystem: integer(row, "is_system"),
            enabled: integer(row, "enabled") ?? 1, toolUsage: integer(row, "tool_usage") ?? 1,
            isConfidential: integer(row, "is_confidential") ?? 0,
            startWithReasoning: integer(row, "start_with_reasoning") ?? 0,
            supportsParallelToolCalls: integer(row, "supports_parallel_tool_calls") ?? 1,
            contextWindow: integer(row, "context_window"), deletedAt: deletedAt ?? string(row, "deleted_at"),
            defaultHash: string(row, "default_hash"), vendor: string(row, "vendor"),
            description: string(row, "description"), userID: string(row, "user_id")
        )
    }

    private static func hashValues(_ values: [Any?]) -> String {
        let string = values.map { value -> String in
            guard let value, !(value is NSNull) else { return "" }
            if let value = value as? String { return value }
            if let value = value as? Int64 { return String(value) }
            if let value = value as? Int { return String(value) }
            if let value = value as? Double { return String(value) }
            return ""
        }.joined(separator: "|")
        var hash: Int32 = 0
        for unit in string.utf16 {
            hash = (hash &* 31) &+ Int32(unit)
        }
        return String(hash, radix: 36)
    }

    private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private static func string(_ row: NativeSyncRow?, _ key: String) -> String? {
        guard let row, case .text(let value)? = row.values[key] else { return nil }
        return value
    }

    private static func integer(_ row: NativeSyncRow?, _ key: String) -> Int64? {
        guard let row, case .integer(let value)? = row.values[key] else { return nil }
        return value
    }

    private static func real(_ row: NativeSyncRow?, _ key: String) -> Double? {
        guard let row else { return nil }
        switch row.values[key] {
        case .real(let value): return value
        case .integer(let value): return Double(value)
        default: return nil
        }
    }

    private static func text(_ value: String?) -> NativeSyncValue { value.map(NativeSyncValue.text) ?? .null }
    private static func integer(_ value: Int64?) -> NativeSyncValue { value.map(NativeSyncValue.integer) ?? .null }
    private static func real(_ value: Double?) -> NativeSyncValue { value.map(NativeSyncValue.real) ?? .null }
}

private extension NativeModelDefault {
    func replacingIdentity(provider: String, isConfidential: Int64) -> NativeModelDefault {
        NativeModelDefault(
            id: id, provider: provider, name: name, model: model, url: url, isSystem: isSystem,
            enabled: enabled, toolUsage: toolUsage, isConfidential: isConfidential,
            startWithReasoning: startWithReasoning, supportsParallelToolCalls: supportsParallelToolCalls,
            contextWindow: contextWindow, deletedAt: deletedAt, defaultHash: defaultHash,
            vendor: vendor, description: description, userID: userID
        )
    }

    func withDeletedAt(_ deletedAt: String?) -> NativeModelDefault {
        NativeModelDefault(
            id: id, provider: provider, name: name, model: model, url: url, isSystem: isSystem,
            enabled: enabled, toolUsage: toolUsage, isConfidential: isConfidential,
            startWithReasoning: startWithReasoning, supportsParallelToolCalls: supportsParallelToolCalls,
            contextWindow: contextWindow, deletedAt: deletedAt, defaultHash: defaultHash,
            vendor: vendor, description: description, userID: userID
        )
    }
}

private extension NativeModelProfileDefault {
    func withDeletedAt(_ deletedAt: String?) -> NativeModelProfileDefault {
        NativeModelProfileDefault(
            modelID: modelID, temperature: temperature, maxSteps: maxSteps,
            maxAttempts: maxAttempts, nudgeThreshold: nudgeThreshold,
            useSystemMessageModeDeveloper: useSystemMessageModeDeveloper,
            toolsOverride: toolsOverride, linkPreviewsOverride: linkPreviewsOverride,
            chatModeAddendum: chatModeAddendum, searchModeAddendum: searchModeAddendum,
            researchModeAddendum: researchModeAddendum,
            citationReinforcementEnabled: citationReinforcementEnabled,
            citationReinforcementPrompt: citationReinforcementPrompt,
            nudgeFinalStep: nudgeFinalStep, nudgePreventive: nudgePreventive,
            nudgeRetry: nudgeRetry, nudgeSearchFinalStep: nudgeSearchFinalStep,
            nudgeSearchPreventive: nudgeSearchPreventive, nudgeSearchRetry: nudgeSearchRetry,
            providerOptionsJSON: providerOptionsJSON, deletedAt: deletedAt
        )
    }
}
