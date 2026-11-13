/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Observation

@MainActor
@Observable
final class NativeModelLibrary {
    private(set) var snapshot: NativeModelCatalogSnapshot?
    private(set) var error: String?
    let repository: NativeModelCatalogRepository
    private let tinfoilSession: NativeTinfoilOAuthSession
    private let store: NativeSyncStore
    private var observation: Task<Void, Never>?
    private var generation = 0
    private var serverDefaults: NativeModelDefaultsPayload?
    private let libraryDefaults: [NativeDefaultsTable]
    @ObservationIgnored var onChange: (() -> Void)?

    private let userID: String

    init(store: NativeSyncStore, userID: String, libraryDefaults: [NativeDefaultsTable] = []) {
        self.store = store
        self.userID = userID
        self.libraryDefaults = libraryDefaults
        repository = NativeModelCatalogRepository(store: store, ownerID: userID)
        tinfoilSession = NativeTinfoilOAuthSession(store: store)
    }

    func start(serverDefaults: NativeModelDefaultsPayload?) async throws {
        self.serverDefaults = serverDefaults
        try await reconcile()
        try await refresh()
        guard observation == nil else { return }
        observation = Task { [weak self, store] in
            do {
                try await withThrowingTaskGroup(of: Void.self) { group in
                    for table in ["models", "model_profiles", "settings", "provider_connections", "models_secrets", "provider_connection_secrets", "integrations_secrets"] {
                        group.addTask { [weak self] in
                            for try await _ in try await store.watch(table: table, includeDeleted: true) {
                                try Task.checkCancellation()
                                try await self?.refresh()
                            }
                        }
                    }
                    group.addTask { [weak self] in
                        var hasCompletedInitialSync = await store.syncStatusSnapshot().initialSyncCompleted
                        for await status in await store.watchSyncStatus() {
                            try Task.checkCancellation()
                            if status.initialSyncCompleted && !hasCompletedInitialSync {
                                hasCompletedInitialSync = true
                                try await self?.reconcile()
                                try await self?.refresh()
                            }
                        }
                    }
                    try await group.waitForAll()
                }
            } catch is CancellationError {
            } catch { self?.error = error.localizedDescription }
        }
    }

    func stop() {
        generation += 1
        observation?.cancel()
        observation = nil
        onChange = nil
    }

    func refresh() async throws {
        generation += 1
        let request = generation
        let value = try await repository.loadSnapshot()
        guard request == generation, !Task.isCancelled else { return }
        snapshot = value
        error = nil
        onChange?()
    }

    func tinfoilCredentials(for expected: NativeModel) -> @Sendable () async throws -> String {
        let repository = repository
        let session = tinfoilSession
        return {
            let snapshot = try await repository.loadSnapshot()
            guard let current = snapshot.models.first(where: { $0.id == expected.id }),
                  current.provider == "tinfoil", current.isSystem != 1, current.isConfigured,
                  current.providerConnectionID == expected.providerConnectionID,
                  current.connectionAuthMethod == expected.connectionAuthMethod,
                  current.url == expected.url else { throw NativeTinfoilOAuthError.connectionChanged }
            if current.oauthProvider == "tinfoil" || current.connectionAuthMethod == "oauth" {
                return try await session.accessToken(modelID: current.id)
            }
            guard let key = current.apiKey, !key.isEmpty else { throw NativeTinfoilOAuthError.credentialUnavailable }
            return key
        }
    }

    private func reconcile() async throws {
        let status = await store.syncStatusSnapshot()
        try await NativeLibraryDefaults.reconcile(libraryDefaults, store: store, userID: userID, initialSyncCompleted: status.initialSyncCompleted)
        _ = try await repository.reconcileDefaults(server: serverDefaults, initialSyncCompleted: status.initialSyncCompleted)
    }
}
