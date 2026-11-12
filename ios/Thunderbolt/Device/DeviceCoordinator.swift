/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Observation
import CryptoKit

actor DeviceDataKeys: E2EEKeyProviding {
    private var keys: [String: Data] = [:]
    private var primary: String?
    private var trusted = false

    func publish(_ keys: [String: Data], primary: String) throws {
        try install(keys, primary: primary, trusted: true)
    }

    func publishLocal(_ keys: [String: Data], primary: String) throws {
        try install(keys, primary: primary, trusted: false)
    }

    func markUntrusted() { trusted = false }

    private func install(_ keys: [String: Data], primary: String, trusted: Bool) throws {
        guard keys["0"]?.count == 32, keys[primary]?.count == 32 else { throw CryptoFailure.keyConfigurationIncomplete }
        self.keys = keys
        self.primary = primary
        self.trusted = trusted
    }

    func clear() { keys = [:]; primary = nil; trusted = false }
    func isTrusted() -> Bool { trusted }
    func isEncryptionConfigured() -> Bool { primary != nil }
    func primaryKeyID() -> String? { primary }
    func dataKey(for keyID: String) -> Data? { keys[keyID] }
}

struct NativeDeviceRecord: Codable, Sendable {
    var id: String
    var keys: ThunderboltDeviceKeys
    var accountKey: Data?
    var dataKeys: [String: Data] = [:]
    var keyVersion = 0
    var primaryKeyID: String?
    var recoveryPhrase: String?
    var pendingBootstrap: DeviceBootstrapRequest?
    var pendingLegacyUpgrade: PendingLegacyUpgrade?
    var approvalSession: LocalApprovalSession? = nil
    var migratedPrototype = false
}

struct PendingLegacyUpgrade: Codable, Sendable {
    let bootstrap: DeviceBootstrapRequest
    let accountKey: Data
    let initialDataKey: Data
    let legacyContentKey: Data
    let possessionProof: String
    let recoveryPhrase: String
    let canarySeed: Data
    let originalRecoveryPhrase: String?
}

enum DeviceSetupState: Equatable {
    case idle, registering, creatingKeys, awaitingApproval, ready, offline
    case failed(String)
}

enum DeviceTrustError: LocalizedError {
    case rollback, replacedAccount, incompleteMetadata, legacyAccount, approvalChanged, invalidRecoveryPhrase
    case operationInProgress, invalidRotationTarget, missingRecoverySlot, invalidRecoveryAnchor
    var errorDescription: String? {
        switch self {
        case .rollback: nativeString( "The server returned an older encryption key. Sync is paused.")
        case .replacedAccount: nativeString( "The account key could not be verified against this device. Sync is paused.")
        case .incompleteMetadata: nativeString( "The server returned incomplete encryption settings.")
        case .legacyAccount: nativeString( "This account needs an encryption upgrade before this device can sync.")
        case .approvalChanged: nativeString( "The device approval changed. Start a new approval code.")
        case .invalidRecoveryPhrase: nativeString( "This recovery phrase does not unlock this account.")
        case .operationInProgress: nativeString( "Another security operation is already in progress.")
        case .invalidRotationTarget: nativeString( "A device key could not be verified for rotation.")
        case .missingRecoverySlot: nativeString( "The account has no verified recovery key. Set a recovery phrase before rotating its encryption key.")
        case .invalidRecoveryAnchor: nativeString( "The server recovery key could not be verified. No keys were changed.")
        }
    }
}

struct ApprovalCodePrompt: Sendable, Equatable {
    let sessionID: String
    let options: [String]
}

private struct PendingDeviceApprovalAttempt {
    let anchor: DeviceApprovalAnchor
    let sessionID: String
    let commitment: String
    let challenge: String
    let reveal: String
    let challengerDeviceID: String
    let options: [String]
}

struct LocalApprovalSession: Codable, Sendable {
    let sessionID: String
    let commitment: String
    let reveal: String
    let startedAt: Date
    var challenge: String?
    var challengerDeviceID: String?
    var code: String?
    var revealSent = false
}

/// Owns a single account's trust lifetime. No codec receives keys until registration,
/// session binding, the authenticated envelope and the local key anchor agree.
@MainActor
@Observable
final class DeviceCoordinator {
    private(set) var state: DeviceSetupState = .idle
    private(set) var record: NativeDeviceRecord?
    private(set) var approvalCode: String?
    let dataKeys = DeviceDataKeys()
    @ObservationIgnored private let vault: DeviceVault
    @ObservationIgnored private let organizationEscrowPublicKey: String?
    @ObservationIgnored private var lifetime = UUID()
    @ObservationIgnored private var owner: (server: String, userID: String)?
    @ObservationIgnored private var localApprovalSession: LocalApprovalSession?
    @ObservationIgnored private var pendingApprovalAttempts: [String: PendingDeviceApprovalAttempt] = [:]
    @ObservationIgnored private var managementOperation: UUID?
    private(set) var lockoutPendingDeviceIDs: [String] = []

    init(vault: DeviceVault = DeviceVault(), organizationEscrowPublicKey: String? = Bundle.main.object(forInfoDictionaryKey: "ThunderboltOrgEscrowPublicKey") as? String) {
        self.vault = vault
        let pin = organizationEscrowPublicKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.organizationEscrowPublicKey = pin.flatMap { $0.isEmpty || $0.hasPrefix("$(") ? nil : $0 }
    }

    func prepare(session: CloudSession, server: String, client: CloudClient, deviceName: String, organizationEscrowPublicKey: String? = nil) async throws {
        let epoch = UUID()
        lifetime = epoch
        state = .registering
        approvalCode = nil
        localApprovalSession = nil
        pendingApprovalAttempts.removeAll()
        let retainsLocalKeys = owner?.server == server && owner?.userID == session.user.id
        owner = (server, session.user.id)
        if retainsLocalKeys { await dataKeys.markUntrusted() }
        else { await dataKeys.clear() }
        do {
            try assertCurrent(epoch)
            var local: NativeDeviceRecord
            if let stored = try vault.load(NativeDeviceRecord.self, server: server, userID: session.user.id) {
                local = stored
            } else {
                let keys = try await Task.detached(priority: .userInitiated) { try ThunderboltCrypto.generateDeviceKeys() }.value
                try assertCurrent(epoch)
                local = NativeDeviceRecord(id: UUID().uuidString.lowercased(), keys: keys)
                try vault.save(local, server: server, userID: session.user.id)
            }
            record = local
            localApprovalSession = local.approvalSession
            client.deviceID = local.id
            let registration = try await client.registerDevice(DeviceRegistrationRequest(
                deviceId: local.id, publicKey: try local.keys.ecdhPublicKeyBase64,
                mlkemPublicKey: local.keys.mlkemPublicKeyBase64, name: deviceName
            ), token: session.token)
            try assertCurrent(epoch)
            let challenge = try await client.bindChallenge(token: session.token)
            let nonce = try ThunderboltCrypto.openBindNonce(challenge.sealed, deviceKeys: local.keys)
            try assertCurrent(epoch)
            try await client.bindDevice(id: local.id, nonce: nonce, token: session.token)
            try assertCurrent(epoch)
            let metadata = try await client.encryptionMetadata(token: session.token)
            try assertCurrent(epoch)
            if metadata == nil {
                guard (local.accountKey == nil || local.pendingBootstrap != nil), local.pendingLegacyUpgrade == nil else {
                    throw DeviceTrustError.replacedAccount
                }
                state = .creatingKeys
                if local.pendingBootstrap == nil {
                    let deviceID = local.id
                    let keys = local.keys
                    let bootstrap = try await Task.detached(priority: .userInitiated) {
                        try ThunderboltCrypto.createBootstrap(userID: session.user.id, deviceID: deviceID, deviceKeys: keys)
                    }.value
                    try assertCurrent(epoch)
                    local.accountKey = bootstrap.accountKey
                    local.dataKeys = ["0": bootstrap.initialDataKey]
                    local.primaryKeyID = "0"
                    local.keyVersion = 1
                    local.recoveryPhrase = bootstrap.recoveryPhrase
                    local.pendingBootstrap = bootstrap.request
                    // Save recovery BEFORE the request: a lost response may still have committed.
                    try vault.save(local, server: server, userID: session.user.id)
                    record = local
                }
                var bootstrapRequest = local.pendingBootstrap!
                if let escrowKey = organizationEscrowPublicKey ?? self.organizationEscrowPublicKey {
                    guard let accountKey = local.accountKey else { throw DeviceTrustError.incompleteMetadata }
                    bootstrapRequest.orgEnvelope = try ThunderboltCrypto.wrapAKForOrganization(accountKey, publicKeyBase64: escrowKey)
                }
                try await client.bootstrapDevice(id: local.id, request: bootstrapRequest, token: session.token)
                try assertCurrent(epoch)
                local.pendingBootstrap = nil
                try vault.save(local, server: server, userID: session.user.id)
                record = local
                try await dataKeys.publish(local.dataKeys, primary: local.primaryKeyID!)
                try assertCurrent(epoch)
                state = .ready
                return
            }
            // A new device must first establish the account through verified approval or recovery.
            guard registration.trusted else {
                state = .awaitingApproval
                return
            }
            guard let metadata else { throw DeviceTrustError.incompleteMetadata }
            if metadata.schemeVersion == 2, local.pendingLegacyUpgrade != nil {
                let pending = local.pendingLegacyUpgrade!
                if try await finishPendingLegacyUpgrade(
                    local: &local, metadata: metadata, userID: session.user.id,
                    server: server, token: session.token, client: client, epoch: epoch
                ) {
                    return
                }
                local.pendingLegacyUpgrade = nil
                local.recoveryPhrase = pending.originalRecoveryPhrase
                local.accountKey = nil
                local.dataKeys = [:]
                local.primaryKeyID = nil
                local.keyVersion = 0
                try vault.save(local, server: server, userID: session.user.id)
                record = local
                state = .awaitingApproval
                return
            }
            if metadata.schemeVersion == 1 {
                try await migrateLegacyV1(
                    local: &local, session: session, server: server, client: client, metadata: metadata,
                    organizationEscrowPublicKey: organizationEscrowPublicKey, epoch: epoch
                )
                return
            }
            guard metadata.schemeVersion == 2 else { throw DeviceTrustError.legacyAccount }
            if local.accountKey == nil {
                guard local.approvalSession != nil,
                      try await adoptApprovedEnvelope(local: &local, metadata: metadata, userID: session.user.id, server: server, token: session.token, client: client, epoch: epoch) else {
                    state = .awaitingApproval
                    return
                }
                try assertCurrent(epoch)
                state = .ready
                return
            }
            let envelope = try await client.deviceEnvelope(token: session.token)
            let wrappedKeys = try await client.wrappedKeys(token: session.token)
            try assertCurrent(epoch)
            guard envelope.trusted else { state = .awaitingApproval; return }
            let opened = try ThunderboltCrypto.unwrapAK(envelope.wrappedCK, deviceKeys: local.keys)
            guard let keyVersion = opened.keyVersion, Int(keyVersion) >= local.keyVersion,
                  Int(keyVersion) == metadata.keyVersion, opened.primaryKeyID == metadata.primaryKeyID else {
                throw DeviceTrustError.rollback
            }
            var keys: [String: Data] = [:]
            for key in wrappedKeys {
                guard keys[key.keyID] == nil else { throw DeviceTrustError.incompleteMetadata }
                keys[key.keyID] = try ThunderboltCrypto.unwrapDEK(key.wrappedKey, accountKey: opened.rawKey, keyID: key.keyID)
            }
            // DEK 0 never changes. Only the locally retained value can anchor a replacement AK.
            guard let oldAnchor = local.dataKeys["0"], keys["0"] == oldAnchor else {
                throw DeviceTrustError.replacedAccount
            }
            guard let iv = metadata.canaryIv, let ciphertext = metadata.canaryCtext else {
                throw DeviceTrustError.incompleteMetadata
            }
            let seed = try ThunderboltCrypto.unwrapCanary(accountKey: opened.rawKey, userID: session.user.id, iv: iv, ciphertext: ciphertext)
            guard try ThunderboltCrypto.signingPublicKey(canarySeed: seed) == metadata.signingPublicKey else {
                throw DeviceTrustError.replacedAccount
            }
            local.accountKey = opened.rawKey
            local.dataKeys = keys
            local.primaryKeyID = opened.primaryKeyID
            local.keyVersion = Int(keyVersion)
            local.pendingBootstrap = nil
            try vault.save(local, server: server, userID: session.user.id)
            record = local
            try await dataKeys.publish(keys, primary: opened.primaryKeyID)
            try assertCurrent(epoch)
            state = .ready
        } catch {
            guard epoch == lifetime else { throw CancellationError() }
            await dataKeys.markUntrusted()
            try assertCurrent(epoch)
            state = record?.accountKey == nil ? .failed(error.localizedDescription) : .offline
            throw error
        }
    }

    private func migrateLegacyV1(
        local: inout NativeDeviceRecord, session: CloudSession, server: String,
        client: CloudClient, metadata: DeviceEncryptionMetadata,
        organizationEscrowPublicKey: String?, epoch: UUID
    ) async throws {
        guard metadata.schemeVersion == 1,
              let canaryIV = metadata.canaryIv,
              let canaryCiphertext = metadata.canaryCtext else {
            throw DeviceTrustError.incompleteMetadata
        }

        if local.pendingLegacyUpgrade == nil {
            let envelope = try await client.deviceEnvelope(token: session.token)
            try assertCurrent(epoch)
            guard envelope.trusted else {
                state = .awaitingApproval
                return
            }
            let contentKey = try LegacyV1Envelope.unwrapContentKey(envelope.wrappedCK, deviceKeys: local.keys)
            let possessionProof = try LegacyV1Envelope.recoverPossessionSecret(
                contentKey: contentKey, iv: canaryIV, ciphertext: canaryCiphertext
            )
            let deviceID = local.id
            let deviceKeys = local.keys
            let bootstrap = try await Task.detached(priority: .userInitiated) {
                try ThunderboltCrypto.createBootstrap(userID: session.user.id, deviceID: deviceID, deviceKeys: deviceKeys)
            }.value
            try assertCurrent(epoch)
            let originalRecoveryPhrase = local.recoveryPhrase
            var request = bootstrap.request
            if let escrowKey = organizationEscrowPublicKey ?? self.organizationEscrowPublicKey {
                request.orgEnvelope = try ThunderboltCrypto.wrapAKForOrganization(
                    bootstrap.accountKey, publicKeyBase64: escrowKey
                )
            }
            local.accountKey = bootstrap.accountKey
            local.dataKeys = ["0": bootstrap.initialDataKey]
            local.primaryKeyID = "0"
            local.keyVersion = 1
            local.recoveryPhrase = bootstrap.recoveryPhrase
            local.pendingLegacyUpgrade = PendingLegacyUpgrade(
                bootstrap: request,
                accountKey: bootstrap.accountKey,
                initialDataKey: bootstrap.initialDataKey,
                legacyContentKey: contentKey,
                possessionProof: possessionProof,
                recoveryPhrase: bootstrap.recoveryPhrase,
                canarySeed: try ThunderboltCrypto.unwrapCanary(
                    accountKey: bootstrap.accountKey, userID: session.user.id,
                    iv: request.canaryIv, ciphertext: request.canaryCtext
                ),
                originalRecoveryPhrase: originalRecoveryPhrase
            )
            // The only usable recovery phrase must survive a lost upgrade response.
            try vault.save(local, server: server, userID: session.user.id)
            record = local
        }

        guard let pending = local.pendingLegacyUpgrade else { throw DeviceTrustError.incompleteMetadata }
        let challenge = try await client.currentDeviceProof(operation: "upgrade", token: session.token)
        try assertCurrent(epoch)
        let request = try LegacyV1UpgradeRequest.make(
            nonce: challenge.nonce, possessionProof: pending.possessionProof,
            deviceID: local.id,
            bootstrap: FirstDeviceBootstrap(
                request: pending.bootstrap,
                accountKey: pending.accountKey,
                initialDataKey: pending.initialDataKey,
                recoveryPhrase: pending.recoveryPhrase,
                keys: local.keys
            ),
            legacyContentKey: pending.legacyContentKey
        )

        do {
            let response = try await client.upgradeLegacyV1(request, token: session.token)
            try assertCurrent(epoch)
            guard response.schemeVersion == 2, response.keyVersion == 1 else { throw DeviceTrustError.rollback }
        } catch {
            // The server may commit and lose the response. Reconcile against the
            // candidate's full authenticated material before deciding what won.
            guard epoch == lifetime else { throw CancellationError() }
            guard let updated = try await client.encryptionMetadata(token: session.token),
                  updated.schemeVersion == 2 else { throw error }
            if try await finishPendingLegacyUpgrade(
                local: &local, metadata: updated, userID: session.user.id,
                server: server, token: session.token, client: client, epoch: epoch
            ) { return }
            if case CloudError.http(409, _) = error {
                guard let pending = local.pendingLegacyUpgrade else { throw error }
                local.pendingLegacyUpgrade = nil
                local.recoveryPhrase = pending.originalRecoveryPhrase
                local.accountKey = nil
                local.dataKeys = [:]
                local.primaryKeyID = nil
                local.keyVersion = 0
                try vault.save(local, server: server, userID: session.user.id)
                record = local
                state = .awaitingApproval
                return
            }
            throw error
        }

        guard let updated = try await client.encryptionMetadata(token: session.token),
              try await finishPendingLegacyUpgrade(
                local: &local, metadata: updated, userID: session.user.id,
                server: server, token: session.token, client: client, epoch: epoch
              ) else { throw DeviceTrustError.incompleteMetadata }
    }

    /// Completes a response-loss retry only when every server anchor is exactly
    /// the locally staged migration. A competing migrator cannot replace local trust.
    private func finishPendingLegacyUpgrade(
        local: inout NativeDeviceRecord, metadata: DeviceEncryptionMetadata, userID: String,
        server: String, token: String, client: CloudClient, epoch: UUID
    ) async throws -> Bool {
        guard let pending = local.pendingLegacyUpgrade else { return false }
        let bootstrap = pending.bootstrap
        guard metadata.schemeVersion == 2, metadata.keyVersion == 1,
              metadata.primaryKeyID == "0",
              metadata.canaryIv == bootstrap.canaryIv,
              metadata.canaryCtext == bootstrap.canaryCtext,
              metadata.signingPublicKey == bootstrap.signingPublicKey,
              metadata.kdfSalt == bootstrap.kdfSalt,
              metadata.recoveryEcdhPublicKey == bootstrap.recoveryEcdhPublicKey,
              metadata.recoveryMlkemPublicKey == bootstrap.recoveryMlkemPublicKey,
              metadata.recoveryWrappedAK == bootstrap.recoveryWrappedAK,
              metadata.recoveryAttestation == bootstrap.recoveryAttestation else { return false }

        let envelope = try await client.deviceEnvelope(token: token)
        let wrappedKeys = try await client.wrappedKeys(token: token)
        try assertCurrent(epoch)
        guard envelope.trusted, envelope.wrappedCK == bootstrap.wrappedCK,
              envelope.attestation == bootstrap.attestation else { return false }
        let opened = try ThunderboltCrypto.unwrapAK(envelope.wrappedCK, deviceKeys: local.keys)
        guard opened.rawKey == pending.accountKey, opened.keyVersion == 1,
              opened.primaryKeyID == "0" else { throw DeviceTrustError.replacedAccount }

        var keyring: [String: Data] = [:]
        for entry in wrappedKeys {
            guard keyring[entry.keyID] == nil else { throw DeviceTrustError.incompleteMetadata }
            keyring[entry.keyID] = try ThunderboltCrypto.unwrapDEK(
                entry.wrappedKey, accountKey: pending.accountKey, keyID: entry.keyID
            )
        }
        guard Set(keyring.keys) == Set(["0", "v1"]),
              keyring["0"] == pending.initialDataKey,
              keyring["v1"] == pending.legacyContentKey,
              let iv = metadata.canaryIv, let ciphertext = metadata.canaryCtext,
              let signingKey = metadata.signingPublicKey,
              let recoveryAttestation = metadata.recoveryAttestation,
              let recoveryEcdh = metadata.recoveryEcdhPublicKey,
              let recoveryMLKEM = metadata.recoveryMlkemPublicKey,
              let salt = metadata.kdfSalt else { throw DeviceTrustError.replacedAccount }
        let canarySeed = try ThunderboltCrypto.unwrapCanary(
            accountKey: pending.accountKey, userID: userID, iv: iv, ciphertext: ciphertext
        )
        guard canarySeed == pending.canarySeed,
              try ThunderboltCrypto.signingPublicKey(canarySeed: canarySeed) == signingKey,
              try ThunderboltCrypto.verifyDeviceAttestation(
                canarySeed: canarySeed, signature: bootstrap.attestation, userID: userID,
                deviceID: local.id, ecdhPublicKey: try local.keys.ecdhPublicKeyBase64,
                mlkemPublicKey: local.keys.mlkemPublicKeyBase64
              ),
              try ThunderboltCrypto.verifyRecoveryAttestation(
                canarySeed: canarySeed, signature: recoveryAttestation, userID: userID,
                kdfSalt: salt, ecdhPublicKey: recoveryEcdh, mlkemPublicKey: recoveryMLKEM
              ) else { throw DeviceTrustError.replacedAccount }

        local.accountKey = pending.accountKey
        local.dataKeys = keyring
        local.primaryKeyID = "0"
        local.keyVersion = 1
        local.pendingLegacyUpgrade = nil
        local.recoveryPhrase = pending.recoveryPhrase
        try vault.save(local, server: server, userID: userID)
        record = local
        try await dataKeys.publish(keyring, primary: "0")
        try assertCurrent(epoch)
        state = .ready
        return true
    }

    /// Opens the protected local keyring for offline history reads. This does not
    /// establish device trust; a successful server registration, sealed bind,
    /// envelope and key-anchor check are still required before sync can connect.
    @discardableResult
    func unlockLocal(server: String, userID: String) async throws -> Bool {
        guard let local = try vault.load(NativeDeviceRecord.self, server: server, userID: userID),
              local.accountKey?.count == 32,
              local.keyVersion >= 1,
              let primary = local.primaryKeyID,
              local.dataKeys["0"]?.count == 32,
              local.dataKeys[primary]?.count == 32,
              local.dataKeys.values.allSatisfy({ $0.count == 32 }) else {
            await dataKeys.clear()
            record = nil
            state = .idle
            return false
        }
        owner = (server, userID)
        record = local
        localApprovalSession = local.approvalSession
        let epoch = lifetime
        try await dataKeys.publishLocal(local.dataKeys, primary: primary)
        try assertCurrent(epoch)
        state = .offline
        return true
    }

    /// Recover this untrusted device from its locally entered BIP-39 phrase.
    /// The phrase-derived public keys, envelope epoch/pointer, DEK-0, canary and
    /// signing key are all checked before the device receives a trusted keyring.
    func recoverWithPhrase(phrase: String, session: CloudSession, server: String, client: CloudClient) async throws {
        guard let owner, owner.server == server, owner.userID == session.user.id,
              var local = record, case .awaitingApproval = state else {
            throw DeviceTrustError.incompleteMetadata
        }
        let epoch = lifetime
        guard let metadata = try await client.encryptionMetadata(token: session.token), metadata.schemeVersion == 2,
              let salt = metadata.kdfSalt,
              let recoveryEcdh = metadata.recoveryEcdhPublicKey,
              let recoveryMLKEM = metadata.recoveryMlkemPublicKey,
              let recoveryEnvelope = metadata.recoveryWrappedAK,
              let recoveryAttestation = metadata.recoveryAttestation,
              let canaryIV = metadata.canaryIv,
              let canaryCiphertext = metadata.canaryCtext,
              let signingPublicKey = metadata.signingPublicKey else {
            throw DeviceTrustError.legacyAccount
        }
        try assertCurrent(epoch)

        let recoveryKeys = try await Task.detached(priority: .userInitiated) {
            try ThunderboltCrypto.deriveRecoveryMaterial(phrase: phrase, kdfSalt: salt)
        }.value
        guard try recoveryKeys.ecdhPublicKeyBase64 == recoveryEcdh,
              recoveryKeys.mlkemPublicKeyBase64 == recoveryMLKEM else {
            throw DeviceTrustError.invalidRecoveryPhrase
        }
        let opened = try ThunderboltCrypto.unwrapAK(recoveryEnvelope, deviceKeys: recoveryKeys)
        guard opened.keyVersion.map(Int.init) == metadata.keyVersion,
              opened.primaryKeyID == metadata.primaryKeyID else { throw DeviceTrustError.rollback }

        let wrappedKeys = try await client.wrappedKeys(token: session.token)
        try assertCurrent(epoch)
        var keyring: [String: Data] = [:]
        for wrappedKey in wrappedKeys {
            guard keyring[wrappedKey.keyID] == nil else { throw DeviceTrustError.incompleteMetadata }
            keyring[wrappedKey.keyID] = try ThunderboltCrypto.unwrapDEK(wrappedKey.wrappedKey, accountKey: opened.rawKey, keyID: wrappedKey.keyID)
        }
        guard keyring["0"]?.count == 32, keyring[opened.primaryKeyID]?.count == 32 else {
            throw DeviceTrustError.incompleteMetadata
        }
        let canarySeed = try ThunderboltCrypto.unwrapCanary(accountKey: opened.rawKey, userID: session.user.id, iv: canaryIV, ciphertext: canaryCiphertext)
        guard try ThunderboltCrypto.signingPublicKey(canarySeed: canarySeed) == signingPublicKey else {
            throw DeviceTrustError.replacedAccount
        }
        guard try ThunderboltCrypto.verifyRecoveryAttestation(
            canarySeed: canarySeed, signature: recoveryAttestation, userID: session.user.id,
            kdfSalt: salt, ecdhPublicKey: recoveryEcdh, mlkemPublicKey: recoveryMLKEM
        ) else { throw DeviceTrustError.replacedAccount }

        let devicePublicKey = try local.keys.ecdhPublicKeyBase64
        let deviceMLKEMPublicKey = local.keys.mlkemPublicKeyBase64
        let targetEnvelope = try ThunderboltCrypto.wrapAK(opened.rawKey, recipient: local.keys, primaryKeyID: opened.primaryKeyID, keyVersion: UInt32(metadata.keyVersion))
        let attestation = try ThunderboltCrypto.signDeviceAttestation(
            canarySeed: canarySeed, userID: session.user.id, deviceID: local.id,
            ecdhPublicKey: devicePublicKey, mlkemPublicKey: deviceMLKEMPublicKey
        )
        let challenge = try await client.currentDeviceProof(operation: "approve", token: session.token)
        let signature = try ThunderboltCrypto.signChallenge(canarySeed: canarySeed, nonce: challenge.nonce, operation: "approve", deviceID: local.id)
        try assertCurrent(epoch)
        try await client.storeApprovedEnvelope(
            DeviceEnvelopeApprovalRequest(
                deviceId: local.id,
                wrappedCK: targetEnvelope,
                attestation: attestation,
                proof: DeviceChallengeProof(signature: signature, nonce: challenge.nonce, operation: "approve", deviceId: local.id)
            ),
            token: session.token
        )
        try assertCurrent(epoch)
        local.accountKey = opened.rawKey
        local.dataKeys = keyring
        local.primaryKeyID = opened.primaryKeyID
        local.keyVersion = metadata.keyVersion
        local.pendingBootstrap = nil
        try vault.save(local, server: server, userID: session.user.id)
        record = local
        try await dataKeys.publish(keyring, primary: opened.primaryKeyID)
        try assertCurrent(epoch)
        state = .ready
    }

    /// Unlocks a pending device through the account passkey's PRF-backed virtual
    /// device. The local passkey-derived public keys and signed slot are checked
    /// before the passkey envelope can authorize a device envelope.
    func recoverWithPasskey(
        credentialID: String,
        prfOutput: Data,
        session: CloudSession,
        server: String,
        client: CloudClient
    ) async throws {
        guard let owner, owner.server == server, owner.userID == session.user.id,
              var local = record, case .awaitingApproval = state else {
            throw DeviceTrustError.incompleteMetadata
        }
        let epoch = lifetime
        guard let metadata = try await client.encryptionMetadata(token: session.token), metadata.schemeVersion == 2,
              metadata.passkeyCredentialID == credentialID,
              let passkeyEcdh = metadata.passkeyEcdhPublicKey,
              let passkeyMLKEM = metadata.passkeyMlkemPublicKey,
              let passkeyEnvelope = metadata.passkeyWrappedAK,
              let passkeyAttestation = metadata.passkeyAttestation,
              let canaryIV = metadata.canaryIv,
              let canaryCiphertext = metadata.canaryCtext,
              let signingPublicKey = metadata.signingPublicKey else {
            throw DeviceTrustError.invalidRecoveryPhrase
        }
        try assertCurrent(epoch)

        let passkeyKeys = try await Task.detached(priority: .userInitiated) {
            try ThunderboltPasskeyCrypto.deriveDeviceKeys(prfOutput: prfOutput)
        }.value
        guard try passkeyKeys.ecdhPublicKeyBase64 == passkeyEcdh,
              passkeyKeys.mlkemPublicKeyBase64 == passkeyMLKEM else {
            throw DeviceTrustError.invalidRecoveryPhrase
        }
        let opened = try ThunderboltCrypto.unwrapAK(passkeyEnvelope, deviceKeys: passkeyKeys)
        guard opened.keyVersion.map(Int.init) == metadata.keyVersion,
              opened.primaryKeyID == metadata.primaryKeyID else { throw DeviceTrustError.rollback }

        let wrappedKeys = try await client.wrappedKeys(token: session.token)
        try assertCurrent(epoch)
        var keyring: [String: Data] = [:]
        for wrappedKey in wrappedKeys {
            guard keyring[wrappedKey.keyID] == nil else { throw DeviceTrustError.incompleteMetadata }
            keyring[wrappedKey.keyID] = try ThunderboltCrypto.unwrapDEK(
                wrappedKey.wrappedKey, accountKey: opened.rawKey, keyID: wrappedKey.keyID
            )
        }
        guard keyring["0"]?.count == 32, keyring[opened.primaryKeyID]?.count == 32 else {
            throw DeviceTrustError.incompleteMetadata
        }
        let canarySeed = try ThunderboltCrypto.unwrapCanary(
            accountKey: opened.rawKey, userID: session.user.id, iv: canaryIV, ciphertext: canaryCiphertext
        )
        guard try ThunderboltCrypto.signingPublicKey(canarySeed: canarySeed) == signingPublicKey,
              try ThunderboltCrypto.verifyPasskeyAttestation(
                canarySeed: canarySeed, signature: passkeyAttestation, userID: session.user.id,
                credentialID: credentialID, ecdhPublicKey: passkeyEcdh, mlkemPublicKey: passkeyMLKEM
              ) else { throw DeviceTrustError.replacedAccount }

        let deviceEcdh = try local.keys.ecdhPublicKeyBase64
        let deviceMLKEM = local.keys.mlkemPublicKeyBase64
        let targetEnvelope = try ThunderboltCrypto.wrapAK(
            opened.rawKey, recipient: local.keys, primaryKeyID: opened.primaryKeyID,
            keyVersion: UInt32(metadata.keyVersion)
        )
        let targetAttestation = try ThunderboltCrypto.signDeviceAttestation(
            canarySeed: canarySeed, userID: session.user.id, deviceID: local.id,
            ecdhPublicKey: deviceEcdh, mlkemPublicKey: deviceMLKEM
        )
        let challenge = try await client.currentDeviceProof(operation: "approve", token: session.token)
        let signature = try ThunderboltCrypto.signChallenge(
            canarySeed: canarySeed, nonce: challenge.nonce, operation: "approve", deviceID: local.id
        )
        try assertCurrent(epoch)
        try await client.storeApprovedEnvelope(
            DeviceEnvelopeApprovalRequest(
                deviceId: local.id, wrappedCK: targetEnvelope, attestation: targetAttestation,
                proof: DeviceChallengeProof(signature: signature, nonce: challenge.nonce, operation: "approve", deviceId: local.id)
            ),
            token: session.token
        )
        try assertCurrent(epoch)
        local.accountKey = opened.rawKey
        local.dataKeys = keyring
        local.primaryKeyID = opened.primaryKeyID
        local.keyVersion = metadata.keyVersion
        local.pendingBootstrap = nil
        try vault.save(local, server: server, userID: session.user.id)
        record = local
        try await dataKeys.publish(keyring, primary: opened.primaryKeyID)
        try assertCurrent(epoch)
        state = .ready
    }

    /// The pending device commits to its reveal before it has received a challenge.
    func startApprovalSession(client: CloudClient, token: String) async throws -> String {
        guard case .awaitingApproval = state, let owner, var local = record else { throw DeviceTrustError.incompleteMetadata }
        let sessionID = try DeviceApprovalCrypto.newSessionID()
        let reveal = try DeviceApprovalCrypto.newNonce()
        let anchor = try deviceAnchor(local, userID: owner.userID)
        let context = try DeviceApprovalCrypto.createContext(anchor: anchor, sessionID: sessionID)
        let commitment = try DeviceApprovalCrypto.commitment(context: context, reveal: reveal)
        let epoch = lifetime
        try await client.startApprovalSession(ApprovalSessionStart(sessionId: sessionID, commitment: commitment), token: token)
        try assertCurrent(epoch)
        let localAttempt = LocalApprovalSession(sessionID: sessionID, commitment: commitment, reveal: reveal, startedAt: Date())
        local.approvalSession = localAttempt
        try vault.save(local, server: owner.server, userID: owner.userID)
        record = local
        localApprovalSession = localAttempt
        approvalCode = nil
        return sessionID
    }

    /// Polls the pending-device relay. The reveal is sent exactly once, only after
    /// the first trusted-device challenge has been observed and checked.
    func pollApprovalCode(client: CloudClient, token: String) async throws -> String? {
        guard var attempt = localApprovalSession, let owner else { throw DeviceTrustError.approvalChanged }
        guard Date().timeIntervalSince(attempt.startedAt) < 600 else {
            localApprovalSession = nil
            approvalCode = nil
            return nil
        }
        let epoch = lifetime
        if attempt.revealSent, var local = record,
           let metadata = try await client.encryptionMetadata(token: token), metadata.schemeVersion == 2,
           try await adoptApprovedEnvelope(local: &local, metadata: metadata, userID: owner.userID, server: owner.server, token: token, client: client, epoch: epoch) {
            state = .ready
            return nil
        }
        try assertCurrent(epoch)
        let response = try await client.myApprovalSession(token: token)
        try assertCurrent(epoch)
        guard response.sessionId == attempt.sessionID, !response.expired else {
            localApprovalSession = nil
            approvalCode = nil
            throw DeviceTrustError.approvalChanged
        }
        guard let challenge = response.challenge, let challengerID = response.challengerDeviceId else { return nil }
        guard isHex(challenge, length: 64), !challengerID.isEmpty else { throw DeviceTrustError.approvalChanged }
        if let frozenChallenge = attempt.challenge {
            guard frozenChallenge == challenge, attempt.challengerDeviceID == challengerID else { throw DeviceTrustError.approvalChanged }
            approvalCode = attempt.code
        } else {
            guard let local = record else { throw DeviceTrustError.incompleteMetadata }
            let context = try DeviceApprovalCrypto.createContext(anchor: deviceAnchor(local, userID: owner.userID), sessionID: attempt.sessionID)
            attempt.challenge = challenge
            attempt.challengerDeviceID = challengerID
            attempt.code = try DeviceApprovalCrypto.code(context: context, challengerDeviceID: challengerID, challenge: challenge, reveal: attempt.reveal)
            localApprovalSession = attempt
            approvalCode = attempt.code
            if var local = record {
                local.approvalSession = attempt
                try vault.save(local, server: owner.server, userID: owner.userID)
                record = local
            }
        }
        if !attempt.revealSent {
            do {
                try await client.revealApprovalSession(ApprovalSessionReveal(sessionId: attempt.sessionID, reveal: attempt.reveal), token: token)
                attempt.revealSent = true
                localApprovalSession = attempt
            } catch CloudError.http(409, _) {
                attempt.revealSent = true
                localApprovalSession = attempt
            }
            if var local = record {
                local.approvalSession = attempt
                try vault.save(local, server: owner.server, userID: owner.userID)
                record = local
            }
        }
        try assertCurrent(epoch)
        if var local = record, let metadata = try await client.encryptionMetadata(token: token), metadata.schemeVersion == 2,
           try await adoptApprovedEnvelope(local: &local, metadata: metadata, userID: owner.userID, server: owner.server, token: token, client: client, epoch: epoch) {
            try assertCurrent(epoch)
            state = .ready
            return nil
        }
        return attempt.code
    }

    /// The trusted device commits the challenge before polling for and validating the reveal.
    func challengePendingDevice(anchor: DeviceApprovalAnchor, client: CloudClient, token: String) async throws -> String {
        guard case .ready = state, let owner, let local = record, anchor.userID == owner.userID,
              anchor.deviceID != local.id else { throw DeviceTrustError.incompleteMetadata }
        let canonical = try DeviceApprovalCrypto.canonicalize(anchor)
        let epoch = lifetime
        let session: ApprovalSessionRecord
        do { session = try await client.pendingApprovalSession(deviceID: anchor.deviceID, token: token) }
        catch { await invalidateTrustIfAccessDenied(error); throw error }
        try assertCurrent(epoch)
        guard !session.expired, let commitment = session.commitment, isHex(commitment, length: 64),
              session.challenge == nil, session.reveal == nil else { throw DeviceTrustError.approvalChanged }
        let challenge = try DeviceApprovalCrypto.newNonce()
        do {
            try await client.challengePendingApproval(deviceID: anchor.deviceID, body: ApprovalSessionChallenge(sessionId: session.sessionId, challenge: challenge), token: token)
        } catch {
            await invalidateTrustIfAccessDenied(error)
            throw error
        }
        try assertCurrent(epoch)
        pendingApprovalAttempts[anchor.deviceID] = PendingDeviceApprovalAttempt(
            anchor: canonical, sessionID: session.sessionId, commitment: commitment,
            challenge: challenge, reveal: "", challengerDeviceID: local.id, options: []
        )
        return session.sessionId
    }

    /// Returns the six code choices only after checking the new device's reveal opens its commitment.
    func pollPendingDeviceCode(deviceID: String, client: CloudClient, token: String) async throws -> ApprovalCodePrompt? {
        guard var attempt = pendingApprovalAttempts[deviceID] else { throw DeviceTrustError.approvalChanged }
        let epoch = lifetime
        let response: ApprovalSessionRecord
        do { response = try await client.pendingApprovalSession(deviceID: deviceID, token: token) }
        catch { await invalidateTrustIfAccessDenied(error); throw error }
        try assertCurrent(epoch)
        guard response.sessionId == attempt.sessionID, !response.expired,
              response.commitment == attempt.commitment else { throw DeviceTrustError.approvalChanged }
        guard let reveal = response.reveal else { return nil }
        if attempt.options.isEmpty {
            guard isHex(reveal, length: 64) else { throw DeviceTrustError.approvalChanged }
            let codeAttempt = DeviceApprovalConfirmation(
                sessionID: attempt.sessionID, commitment: attempt.commitment, challenge: attempt.challenge,
                reveal: reveal, code: "00"
            )
            guard let code = try DeviceApprovalCrypto.verifiedCode(anchor: attempt.anchor, attempt: codeAttempt, challengerDeviceID: attempt.challengerDeviceID) else {
                throw DeviceTrustError.approvalChanged
            }
            attempt = PendingDeviceApprovalAttempt(
                anchor: attempt.anchor, sessionID: attempt.sessionID, commitment: attempt.commitment,
                challenge: attempt.challenge, reveal: reveal, challengerDeviceID: attempt.challengerDeviceID,
                options: try DeviceApprovalCrypto.options(for: code)
            )
            pendingApprovalAttempts[deviceID] = attempt
        }
        return ApprovalCodePrompt(sessionID: attempt.sessionID, options: attempt.options)
    }

    /// Rechecks the selected short code, local AK witness, current canary and
    /// signed pointer before sharing the AK envelope with the pending device.
    func approvePendingDevice(deviceID: String, selectedCode: String, client: CloudClient, token: String) async throws {
        guard let attempt = pendingApprovalAttempts[deviceID], attempt.options.contains(selectedCode),
              let owner, let local = record, case .ready = state,
              let localAK = local.accountKey, let primaryID = local.primaryKeyID else { throw DeviceTrustError.approvalChanged }
        let epoch = lifetime
        let confirmation = DeviceApprovalConfirmation(
            sessionID: attempt.sessionID, commitment: attempt.commitment, challenge: attempt.challenge,
            reveal: attempt.reveal, code: selectedCode
        )
        guard try DeviceApprovalCrypto.matches(confirmation, anchor: attempt.anchor, challengerDeviceID: attempt.challengerDeviceID) else {
            throw DeviceTrustError.approvalChanged
        }
        guard let metadata = try await client.encryptionMetadata(token: token), metadata.schemeVersion == 2,
              metadata.primaryKeyID == primaryID, metadata.keyVersion == local.keyVersion,
              let canaryIV = metadata.canaryIv, let canaryCiphertext = metadata.canaryCtext,
              let serverSigningKey = metadata.signingPublicKey else { throw DeviceTrustError.incompleteMetadata }
        let ownEnvelope = try await client.deviceEnvelope(token: token)
        guard ownEnvelope.trusted else { throw DeviceTrustError.approvalChanged }
        let opened = try ThunderboltCrypto.unwrapAK(ownEnvelope.wrappedCK, deviceKeys: local.keys)
        guard opened.rawKey == localAK, opened.primaryKeyID == primaryID,
              opened.keyVersion.map(Int.init) == local.keyVersion else { throw DeviceTrustError.replacedAccount }
        let wrappedKeys = try await client.wrappedKeys(token: token)
        guard let wrappedZero = wrappedKeys.first(where: { $0.keyID == "0" }),
              let localZero = local.dataKeys["0"],
              try ThunderboltCrypto.unwrapDEK(wrappedZero.wrappedKey, accountKey: localAK, keyID: "0") == localZero else {
            throw DeviceTrustError.replacedAccount
        }
        let canarySeed = try ThunderboltCrypto.unwrapCanary(accountKey: localAK, userID: owner.userID, iv: canaryIV, ciphertext: canaryCiphertext)
        guard try ThunderboltCrypto.signingPublicKey(canarySeed: canarySeed) == serverSigningKey else {
            throw DeviceTrustError.replacedAccount
        }
        let deviceID = attempt.anchor.deviceID
        let approverDeviceID = local.id
        let proofChallenge = try await client.currentDeviceProof(operation: "approve", token: token)
        let signature = try ThunderboltCrypto.signChallenge(canarySeed: canarySeed, nonce: proofChallenge.nonce, operation: "approve", deviceID: approverDeviceID)
        guard let targetEcdh = Data(base64Encoded: attempt.anchor.ecdhPublicKey),
              let targetMLKEM = Data(base64Encoded: attempt.anchor.mlkemPublicKey) else { throw DeviceTrustError.approvalChanged }
        let wrappedAK = try ThunderboltCrypto.wrapAK(localAK, recipientEcdhPublicKey: targetEcdh, recipientMLKEMPublicKey: targetMLKEM, primaryKeyID: primaryID, keyVersion: UInt32(local.keyVersion))
        let attestation = try ThunderboltCrypto.signDeviceAttestation(canarySeed: canarySeed, userID: owner.userID, deviceID: deviceID, ecdhPublicKey: attempt.anchor.ecdhPublicKey, mlkemPublicKey: attempt.anchor.mlkemPublicKey)
        try assertCurrent(epoch)
        do {
            try await client.storeApprovedEnvelope(
                DeviceEnvelopeApprovalRequest(
                    deviceId: deviceID, wrappedCK: wrappedAK, attestation: attestation,
                    proof: DeviceChallengeProof(signature: signature, nonce: proofChallenge.nonce, operation: "approve", deviceId: approverDeviceID)
                ), token: token
            )
        } catch {
            do { _ = try await verifiedRotationSnapshot(client: client, token: token, epoch: epoch) }
            catch {
                await dataKeys.markUntrusted()
                state = .offline
            }
            throw error
        }
        try assertCurrent(epoch)
        pendingApprovalAttempts.removeValue(forKey: deviceID)
    }

    /// Adopts an envelope only after a code session created on this device was
    /// committed, challenged, revealed, and locally verified. This also makes a
    /// committed approval recoverable after a lost response or app restart.
    private func adoptApprovedEnvelope(
        local: inout NativeDeviceRecord,
        metadata: DeviceEncryptionMetadata,
        userID: String,
        server: String,
        token: String,
        client: CloudClient,
        epoch: UUID
    ) async throws -> Bool {
        guard let approval = local.approvalSession,
              try verifiedLocalApproval(approval, local: local, userID: userID) else { return false }
        let envelope: DeviceEnvelopeResponse
        do { envelope = try await client.deviceEnvelope(token: token) }
        catch CloudError.http(404, _) { return false }
        try assertCurrent(epoch)
        guard envelope.trusted, let attestation = envelope.attestation else { return false }

        let opened = try ThunderboltCrypto.unwrapAK(envelope.wrappedCK, deviceKeys: local.keys)
        guard let keyVersion = opened.keyVersion, Int(keyVersion) == metadata.keyVersion,
              opened.primaryKeyID == metadata.primaryKeyID else {
            throw DeviceTrustError.rollback
        }
        let wrappedKeys = try await client.wrappedKeys(token: token)
        try assertCurrent(epoch)
        let primaryID = opened.primaryKeyID
        var keyring: [String: Data] = [:]
        for wrappedKey in wrappedKeys {
            guard keyring[wrappedKey.keyID] == nil else { throw DeviceTrustError.incompleteMetadata }
            keyring[wrappedKey.keyID] = try ThunderboltCrypto.unwrapDEK(wrappedKey.wrappedKey, accountKey: opened.rawKey, keyID: wrappedKey.keyID)
        }
        guard keyring["0"]?.count == 32, keyring[primaryID]?.count == 32,
              let canaryIV = metadata.canaryIv, let canaryCiphertext = metadata.canaryCtext,
              let signingPublicKey = metadata.signingPublicKey else { throw DeviceTrustError.incompleteMetadata }
        let canarySeed = try ThunderboltCrypto.unwrapCanary(accountKey: opened.rawKey, userID: userID, iv: canaryIV, ciphertext: canaryCiphertext)
        guard try ThunderboltCrypto.signingPublicKey(canarySeed: canarySeed) == signingPublicKey,
              try ThunderboltCrypto.verifyDeviceAttestation(
                canarySeed: canarySeed, signature: attestation, userID: userID, deviceID: local.id,
                ecdhPublicKey: try local.keys.ecdhPublicKeyBase64, mlkemPublicKey: local.keys.mlkemPublicKeyBase64
              ) else { throw DeviceTrustError.replacedAccount }

        local.accountKey = opened.rawKey
        local.dataKeys = keyring
        local.primaryKeyID = primaryID
        local.keyVersion = Int(keyVersion)
        local.approvalSession = nil
        try assertCurrent(epoch)
        try vault.save(local, server: server, userID: userID)
        record = local
        localApprovalSession = nil
        approvalCode = nil
        try await dataKeys.publish(keyring, primary: primaryID)
        try assertCurrent(epoch)
        return true
    }

    private func verifiedLocalApproval(_ attempt: LocalApprovalSession, local: NativeDeviceRecord, userID: String) throws -> Bool {
        guard let challenge = attempt.challenge, let challenger = attempt.challengerDeviceID,
              let code = attempt.code, attempt.revealSent,
              isHex(attempt.sessionID, length: 32), isHex(attempt.commitment, length: 64),
              isHex(attempt.reveal, length: 64), isHex(challenge, length: 64) else { return false }
        let anchor = try deviceAnchor(local, userID: userID)
        let context = try DeviceApprovalCrypto.createContext(anchor: anchor, sessionID: attempt.sessionID)
        guard try DeviceApprovalCrypto.commitment(context: context, reveal: attempt.reveal) == attempt.commitment else { return false }
        let confirmation = DeviceApprovalConfirmation(
            sessionID: attempt.sessionID, commitment: attempt.commitment, challenge: challenge,
            reveal: attempt.reveal, code: code
        )
        return try DeviceApprovalCrypto.matches(confirmation, anchor: anchor, challengerDeviceID: challenger)
    }

    /// Adds the passkey's PRF-derived hybrid keys as a virtual recipient, rotating
    /// the AK so the new slot is anchored to the same verified epoch as devices.
    func enrollPasskeySlot(credentialID: String, prfOutput: Data, client: CloudClient, token: String) async throws {
        guard case .ready = state, !credentialID.isEmpty,
              let metadata = try await client.encryptionMetadata(token: token),
              metadata.schemeVersion == 2, metadata.passkeyCredentialID == nil else {
            throw DeviceTrustError.invalidRotationTarget
        }
        let keys = try await Task.detached(priority: .userInitiated) {
            try ThunderboltPasskeyCrypto.deriveDeviceKeys(prfOutput: prfOutput)
        }.value
        _ = try await rotateAccountKey(
            changeRecoveryPhrase: false, stepUpOTP: nil, mintNewPrimary: false,
            excludedDeviceIDs: [], dropInvalidPasskey: false,
            passkeyPlan: .set(credentialID: credentialID, keys: keys),
            organizationEscrowPublicKey: nil, client: client, token: token
        )
    }

    /// Removes the encrypted-sync passkey slot before its Better Auth credential
    /// is deleted. A fresh primary DEK also excludes passkey-only holders from
    /// reading writes committed after removal.
    func removePasskeySlot(credentialID: String, client: CloudClient, token: String) async throws {
        guard case .ready = state else { throw DeviceTrustError.incompleteMetadata }
        guard let metadata = try await client.encryptionMetadata(token: token), metadata.schemeVersion == 2,
              metadata.passkeyCredentialID == credentialID else { throw DeviceTrustError.invalidRecoveryPhrase }
        _ = try await rotateAccountKey(
            changeRecoveryPhrase: false, stepUpOTP: nil, mintNewPrimary: true,
            excludedDeviceIDs: [], dropInvalidPasskey: false,
            passkeyPlan: .remove,
            organizationEscrowPublicKey: nil, client: client, token: token
        )
    }

    func requestRecoveryPhraseChangeCode(client: CloudClient, token: String) async throws {
        guard case .ready = state else { throw DeviceTrustError.incompleteMetadata }
        do { try await client.requestRecoveryPhraseChangeCode(token: token) }
        catch { await invalidateTrustIfAccessDenied(error); throw error }
    }

    func changeRecoveryPhrase(
        stepUpOTP: String,
        organizationEscrowPublicKey: String? = nil,
        client: CloudClient,
        token: String
    ) async throws -> String {
        guard !stepUpOTP.isEmpty else { throw DeviceTrustError.invalidRecoveryPhrase }
        return try await rotateAccountKey(
            changeRecoveryPhrase: true, stepUpOTP: stepUpOTP, mintNewPrimary: false,
            excludedDeviceIDs: [], dropInvalidPasskey: false,
            organizationEscrowPublicKey: organizationEscrowPublicKey, client: client, token: token
        )!
    }

    /// Revocation commits the server access cut first. A failure after that point
    /// is returned as `true`, and remains visible in the server lockout-pending list.
    func revokeDevice(
        deviceID: String,
        organizationEscrowPublicKey: String? = nil,
        client: CloudClient,
        token: String
    ) async throws -> Bool {
        guard case .ready = state, let local = record, let owner, local.id != deviceID else {
            throw DeviceTrustError.invalidRotationTarget
        }
        guard managementOperation == nil else { throw DeviceTrustError.operationInProgress }
        let operation = UUID()
        managementOperation = operation
        defer { if managementOperation == operation { managementOperation = nil } }
        let epoch = lifetime
        let canary = try await verifiedRotationSnapshot(client: client, token: token, epoch: epoch)
        _ = try await rotationRecoveryMaterial(
            changePhrase: false, metadata: canary.metadata, canarySeed: canary.seed,
            userID: owner.userID
        )
        do {
            let challenge = try await client.currentDeviceProof(operation: "revoke", token: token)
            try assertCurrent(epoch)
            let proof = DeviceChallengeProof(
                signature: try ThunderboltCrypto.signChallenge(canarySeed: canary.seed, nonce: challenge.nonce, operation: "revoke", deviceID: local.id),
                nonce: challenge.nonce, operation: "revoke", deviceId: local.id
            )
            try await client.revokeAccountDevice(deviceID: deviceID, proof: proof, token: token)
            try assertCurrent(epoch)
        } catch {
            do { _ = try await verifiedRotationSnapshot(client: client, token: token, epoch: epoch) }
            catch {
                await dataKeys.markUntrusted()
                state = .offline
            }
            throw error
        }
        do {
            _ = try await rotateAccountKey(
                changeRecoveryPhrase: false, stepUpOTP: nil, mintNewPrimary: true,
                excludedDeviceIDs: [deviceID], dropInvalidPasskey: true,
                organizationEscrowPublicKey: organizationEscrowPublicKey, operationID: operation,
                client: client, token: token
            )
            lockoutPendingDeviceIDs.removeAll { $0 == deviceID }
            return false
        } catch {
            lockoutPendingDeviceIDs = (try? await client.lockoutPendingDevices(token: token).deviceIDs) ?? [deviceID]
            return true
        }
    }

    func pendingLockoutDeviceIDs(client: CloudClient, token: String) async throws -> [String] {
        guard case .ready = state else { throw DeviceTrustError.incompleteMetadata }
        let pending: [String]
        do { pending = try await client.lockoutPendingDevices(token: token).deviceIDs }
        catch { await invalidateTrustIfAccessDenied(error); throw error }
        lockoutPendingDeviceIDs = pending
        return pending
    }

    func finishDeviceLockout(
        organizationEscrowPublicKey: String? = nil,
        client: CloudClient,
        token: String
    ) async throws {
        let pending = try await pendingLockoutDeviceIDs(client: client, token: token)
        guard !pending.isEmpty else { return }
        _ = try await rotateAccountKey(
            changeRecoveryPhrase: false, stepUpOTP: nil, mintNewPrimary: true,
            excludedDeviceIDs: [], dropInvalidPasskey: true,
            organizationEscrowPublicKey: organizationEscrowPublicKey, client: client, token: token
        )
        lockoutPendingDeviceIDs.removeAll()
    }

    func requestAccountDeletionCode(client: CloudClient, token: String) async throws {
        try await client.requestAccountDeletionCode(token: token)
    }

    func deleteAccount(stepUpOTP: String, client: CloudClient, token: String) async throws {
        try await client.deleteAccount(stepUpOTP: stepUpOTP, token: token)
        await suspend()
    }

    private func invalidateTrustIfAccessDenied(_ error: Error) async {
        guard let cloudError = error as? CloudError,
              case .http(let status, _) = cloudError, status == 401 || status == 403 else { return }
        await dataKeys.markUntrusted()
        state = .offline
    }

    private func rotateAccountKey(
        changeRecoveryPhrase: Bool,
        stepUpOTP: String?,
        mintNewPrimary: Bool,
        excludedDeviceIDs: [String],
        dropInvalidPasskey: Bool,
        passkeyPlan: PasskeyRotationPlan = .preserve,
        organizationEscrowPublicKey: String?,
        operationID: UUID? = nil,
        client: CloudClient,
        token: String
    ) async throws -> String? {
        guard case .ready = state, let owner, var local = record else { throw DeviceTrustError.incompleteMetadata }
        let originalRecoveryPhrase = local.recoveryPhrase
        let operation = operationID ?? UUID()
        guard managementOperation == nil || managementOperation == operation else { throw DeviceTrustError.operationInProgress }
        let ownsOperation = managementOperation == nil
        if ownsOperation { managementOperation = operation }
        defer { if ownsOperation, managementOperation == operation { managementOperation = nil } }
        let epoch = lifetime
        var requestSubmitted = false
        var localStateVerified = false
        do {
            let verified = try await verifiedRotationSnapshot(client: client, token: token, epoch: epoch)
            localStateVerified = true
            let metadata = verified.metadata
            guard let localAK = local.accountKey, let oldPrimary = local.primaryKeyID,
                  local.keyVersion == metadata.keyVersion, oldPrimary == metadata.primaryKeyID else {
                throw DeviceTrustError.rollback
            }

            let rotationChallenge = try await client.currentDeviceProof(operation: "rotate", token: token)
            try assertCurrent(epoch)
            let proof = DeviceChallengeProof(
                signature: try ThunderboltCrypto.signChallenge(canarySeed: verified.seed, nonce: rotationChallenge.nonce, operation: "rotate", deviceID: local.id),
                nonce: rotationChallenge.nonce, operation: "rotate", deviceId: local.id
            )

            let existingKeys = try await client.rotationWrappedKeys(token: token)
            guard !existingKeys.isEmpty else { throw DeviceTrustError.incompleteMetadata }
            var keyring: [String: Data] = [:]
            var wrappedKeys: [RotationKey] = []
            let seenIDs = Set(existingKeys.map(\.keyID))
            guard seenIDs.count == existingKeys.count, seenIDs.contains("0"),
                  seenIDs == Set(local.dataKeys.keys) else { throw DeviceTrustError.replacedAccount }
            for entry in existingKeys {
                let dataKey = try ThunderboltCrypto.unwrapDEK(entry.wrappedKey, accountKey: localAK, keyID: entry.keyID)
                guard dataKey.count == 32 else { throw DeviceTrustError.replacedAccount }
                keyring[entry.keyID] = dataKey
            }
            guard keyring["0"] == local.dataKeys["0"] else { throw DeviceTrustError.replacedAccount }

            let recovery = try await rotationRecoveryMaterial(
                changePhrase: changeRecoveryPhrase, metadata: metadata, canarySeed: verified.seed,
                userID: owner.userID
            )
            let newAK = try ThunderboltCrypto.generateAccountKey()
            let newVersion = local.keyVersion.addingReportingOverflow(1)
            guard !newVersion.overflow, newVersion.partialValue > 0,
                  newVersion.partialValue <= Int(UInt32.max) else { throw DeviceTrustError.rollback }
            let sealedVersion = UInt32(newVersion.partialValue)
            let newPrimary: RotationKey?
            let primaryID: String
            if mintNewPrimary {
                primaryID = try Self.nextPrimaryKeyID(existing: seenIDs)
                let dataKey = try ThunderboltCrypto.randomBytes(count: 32)
                newPrimary = RotationKey(keyId: primaryID, wrappedKey: try ThunderboltCrypto.wrapDEK(dataKey, accountKey: newAK, keyID: primaryID))
                keyring[primaryID] = dataKey
            } else {
                primaryID = oldPrimary
                newPrimary = nil
            }
            for keyID in seenIDs.sorted(by: Self.keyIDOrder) {
                guard let dataKey = keyring[keyID] else { throw DeviceTrustError.incompleteMetadata }
                wrappedKeys.append(RotationKey(keyId: keyID, wrappedKey: try ThunderboltCrypto.wrapDEK(dataKey, accountKey: newAK, keyID: keyID)))
            }

            let canary = try ThunderboltCrypto.mintCanary(accountKey: newAK, userID: owner.userID)
            let targetResponse = try await client.rotationEnvelopeTargets(token: token)
            let targets = targetResponse.devices
            let excluded = Set(excludedDeviceIDs)
            guard !targets.isEmpty, Set(targets.map(\.deviceID)).count == targets.count,
                  targets.contains(where: { $0.deviceID == local.id }) else { throw DeviceTrustError.invalidRotationTarget }
            var envelopes: [RotationDeviceEnvelope] = []
            for target in targets where !excluded.contains(target.deviceID) {
                guard let priorAttestation = target.attestation,
                      try ThunderboltCrypto.verifyDeviceAttestation(
                        canarySeed: verified.seed, signature: priorAttestation, userID: owner.userID,
                        deviceID: target.deviceID, ecdhPublicKey: target.ecdhPublicKey, mlkemPublicKey: target.mlkemPublicKey
                      ),
                      let ecdh = Data(base64Encoded: target.ecdhPublicKey),
                      let mlkem = Data(base64Encoded: target.mlkemPublicKey) else { throw DeviceTrustError.invalidRotationTarget }
                _ = try DeviceApprovalCrypto.canonicalize(DeviceApprovalAnchor(
                    userID: owner.userID, deviceID: target.deviceID,
                    ecdhPublicKey: target.ecdhPublicKey, mlkemPublicKey: target.mlkemPublicKey
                ))
                envelopes.append(RotationDeviceEnvelope(
                    deviceId: target.deviceID,
                    wrappedCK: try ThunderboltCrypto.wrapAK(newAK, recipientEcdhPublicKey: ecdh, recipientMLKEMPublicKey: mlkem, primaryKeyID: primaryID, keyVersion: sealedVersion),
                    attestation: try ThunderboltCrypto.signDeviceAttestation(
                        canarySeed: canary.seed, userID: owner.userID, deviceID: target.deviceID,
                        ecdhPublicKey: target.ecdhPublicKey, mlkemPublicKey: target.mlkemPublicKey
                    )
                ))
            }
            guard envelopes.contains(where: { $0.deviceId == local.id }) else { throw DeviceTrustError.invalidRotationTarget }

            let recoveryEcdh = recovery.ecdhPublicKey.base64EncodedString()
            let recoveryMLKEM = recovery.mlkemPublicKey.base64EncodedString()
            let recoveryAttestation = try ThunderboltCrypto.signRecoveryAttestation(
                canary: canary, userID: owner.userID, kdfSalt: recovery.kdfSalt,
                ecdhPublicKey: recoveryEcdh, mlkemPublicKey: recoveryMLKEM
            )
            let recoveryWrappedAK = try ThunderboltCrypto.wrapAK(
                newAK, recipientEcdhPublicKey: recovery.ecdhPublicKey,
                recipientMLKEMPublicKey: recovery.mlkemPublicKey, primaryKeyID: primaryID, keyVersion: sealedVersion
            )
            let passkey = try await rotationPasskeyMaterial(
                plan: passkeyPlan, metadata: metadata, oldCanarySeed: verified.seed, newCanary: canary,
                newAK: newAK, primaryID: primaryID, keyVersion: sealedVersion,
                userID: owner.userID, dropInvalid: dropInvalidPasskey
            )
            let escrowKey = organizationEscrowPublicKey ?? self.organizationEscrowPublicKey
            let orgEnvelope = try escrowKey.map { try ThunderboltCrypto.wrapAKForOrganization(newAK, publicKeyBase64: $0) }

            if let phrase = recovery.phrase {
                local.recoveryPhrase = phrase
                try vault.save(local, server: owner.server, userID: owner.userID)
                record = local
            }
            try assertCurrent(epoch)
            requestSubmitted = true
            let response = try await client.rotateAccountKey(AccountKeyRotationRequest(
                proof: proof, stepUpOtp: stepUpOTP, envelopes: envelopes, wrappedKeys: wrappedKeys,
                newPrimaryKey: newPrimary, canaryIv: canary.iv, canaryCtext: canary.ciphertext,
                signingPublicKey: canary.signingPublicKey, kdfSalt: recovery.kdfSalt,
                recoveryEcdhPublicKey: recoveryEcdh, recoveryMlkemPublicKey: recoveryMLKEM,
                recoveryWrappedAK: recoveryWrappedAK, recoveryAttestation: recoveryAttestation,
                passkeyCredentialId: passkey?.credentialID, passkeyEcdhPublicKey: passkey?.ecdhPublicKey,
                passkeyMlkemPublicKey: passkey?.mlkemPublicKey, passkeyWrappedAK: passkey?.wrappedAK,
                passkeyAttestation: passkey?.attestation, orgEnvelope: orgEnvelope
            ), token: token)
            try assertCurrent(epoch)
            guard response.keyVersion == newVersion.partialValue else { throw DeviceTrustError.rollback }
            local.accountKey = newAK
            local.dataKeys = keyring
            local.primaryKeyID = primaryID
            local.keyVersion = response.keyVersion
            try vault.save(local, server: owner.server, userID: owner.userID)
            record = local
            try await dataKeys.publish(keyring, primary: primaryID)
            try assertCurrent(epoch)
            state = .ready
            return recovery.phrase
        } catch {
            guard epoch == lifetime else { throw CancellationError() }
            if requestSubmitted, case CloudError.http(let status, _) = error, status < 500 {
                local.recoveryPhrase = originalRecoveryPhrase
                try? vault.save(local, server: owner.server, userID: owner.userID)
                record = local
            }
            var restoredTrust = false
            if requestSubmitted, let local = record {
                do {
                    _ = try await verifiedRotationSnapshot(client: client, token: token, epoch: epoch)
                    guard let primaryID = local.primaryKeyID else { throw DeviceTrustError.incompleteMetadata }
                    try await dataKeys.publish(local.dataKeys, primary: primaryID)
                    state = .ready
                    restoredTrust = true
                } catch {}
            } else if localStateVerified {
                state = .ready
                restoredTrust = true
            }
            if !restoredTrust {
                await dataKeys.markUntrusted()
                state = .offline
            }
            throw error
        }
    }

    private struct VerifiedRotationState {
        let metadata: DeviceEncryptionMetadata
        let seed: Data
    }

    private struct RecoveryRotationMaterial {
        let ecdhPublicKey: Data
        let mlkemPublicKey: Data
        let kdfSalt: String
        let phrase: String?
    }

    private struct PasskeyRotationMaterial {
        let credentialID: String
        let ecdhPublicKey: String
        let mlkemPublicKey: String
        let wrappedAK: String
        let attestation: String
    }

    private enum PasskeyRotationPlan {
        case preserve
        case set(credentialID: String, keys: ThunderboltDeviceKeys)
        case remove
    }

    private func verifiedRotationSnapshot(client: CloudClient, token: String, epoch: UUID) async throws -> VerifiedRotationState {
        guard let owner, let local = record, let accountKey = local.accountKey,
              let primaryID = local.primaryKeyID else { throw DeviceTrustError.incompleteMetadata }
        guard let metadata = try await client.encryptionMetadata(token: token), metadata.schemeVersion == 2 else {
            throw DeviceTrustError.incompleteMetadata
        }
        try assertCurrent(epoch)
        guard metadata.keyVersion == local.keyVersion, metadata.primaryKeyID == primaryID,
              let canaryIV = metadata.canaryIv, let canaryCtext = metadata.canaryCtext,
              let signingPublicKey = metadata.signingPublicKey else { throw DeviceTrustError.rollback }
        let envelope = try await client.deviceEnvelope(token: token)
        guard envelope.trusted, let attestation = envelope.attestation else { throw DeviceTrustError.replacedAccount }
        let opened = try ThunderboltCrypto.unwrapAK(envelope.wrappedCK, deviceKeys: local.keys)
        guard opened.rawKey == accountKey, opened.primaryKeyID == primaryID,
              opened.keyVersion.map(Int.init) == local.keyVersion else { throw DeviceTrustError.replacedAccount }
        let seed = try ThunderboltCrypto.unwrapCanary(accountKey: accountKey, userID: owner.userID, iv: canaryIV, ciphertext: canaryCtext)
        guard try ThunderboltCrypto.signingPublicKey(canarySeed: seed) == signingPublicKey,
              try ThunderboltCrypto.verifyDeviceAttestation(
                canarySeed: seed, signature: attestation, userID: owner.userID, deviceID: local.id,
                ecdhPublicKey: try local.keys.ecdhPublicKeyBase64, mlkemPublicKey: local.keys.mlkemPublicKeyBase64
              ) else { throw DeviceTrustError.replacedAccount }
        return VerifiedRotationState(metadata: metadata, seed: seed)
    }

    private func rotationRecoveryMaterial(changePhrase: Bool, metadata: DeviceEncryptionMetadata, canarySeed: Data, userID: String) async throws -> RecoveryRotationMaterial {
        if changePhrase {
            let fresh = try await Task.detached(priority: .userInitiated) { try ThunderboltCrypto.generateRecoveryMaterial() }.value
            return RecoveryRotationMaterial(ecdhPublicKey: try fresh.keys.ecdhPublicKeyRaw, mlkemPublicKey: fresh.keys.mlkemPublicKey, kdfSalt: fresh.kdfSalt, phrase: fresh.phrase)
        }
        guard let salt = metadata.kdfSalt, let ecdh = metadata.recoveryEcdhPublicKey,
              let mlkem = metadata.recoveryMlkemPublicKey, let attestation = metadata.recoveryAttestation else {
            throw DeviceTrustError.missingRecoverySlot
        }
        guard try ThunderboltCrypto.verifyRecoveryAttestation(
            canarySeed: canarySeed, signature: attestation, userID: userID,
            kdfSalt: salt, ecdhPublicKey: ecdh, mlkemPublicKey: mlkem
        ) else { throw DeviceTrustError.invalidRecoveryAnchor }
        let anchor = try DeviceApprovalCrypto.canonicalize(DeviceApprovalAnchor(userID: userID, deviceID: "recovery-slot", ecdhPublicKey: ecdh, mlkemPublicKey: mlkem))
        return RecoveryRotationMaterial(
            ecdhPublicKey: Data(base64Encoded: anchor.ecdhPublicKey)!,
            mlkemPublicKey: Data(base64Encoded: anchor.mlkemPublicKey)!, kdfSalt: salt, phrase: nil
        )
    }

    private func rotationPasskeyMaterial(
        plan: PasskeyRotationPlan, metadata: DeviceEncryptionMetadata, oldCanarySeed: Data, newCanary: CanaryMaterial,
        newAK: Data, primaryID: String, keyVersion: UInt32, userID: String, dropInvalid: Bool
    ) async throws -> PasskeyRotationMaterial? {
        switch plan {
        case .remove:
            return nil
        case .set(let credentialID, let keys):
            guard !credentialID.isEmpty else { throw DeviceTrustError.invalidRotationTarget }
            let ecdh = try keys.ecdhPublicKeyBase64
            let mlkem = keys.mlkemPublicKeyBase64
            return PasskeyRotationMaterial(
                credentialID: credentialID, ecdhPublicKey: ecdh, mlkemPublicKey: mlkem,
                wrappedAK: try ThunderboltCrypto.wrapAK(
                    newAK, recipientEcdhPublicKey: keys.ecdhPublicKeyRaw,
                    recipientMLKEMPublicKey: keys.mlkemPublicKey, primaryKeyID: primaryID, keyVersion: keyVersion
                ),
                attestation: try ThunderboltCrypto.signPasskeyAttestation(
                    canary: newCanary, userID: userID, credentialID: credentialID,
                    ecdhPublicKey: ecdh, mlkemPublicKey: mlkem
                )
            )
        case .preserve:
            break
        }
        guard let credentialID = metadata.passkeyCredentialID else { return nil }
        let anchor: DeviceApprovalAnchor
        do {
            guard let ecdh = metadata.passkeyEcdhPublicKey, let mlkem = metadata.passkeyMlkemPublicKey,
                  let oldAttestation = metadata.passkeyAttestation,
                  try ThunderboltCrypto.verifyPasskeyAttestation(
                    canarySeed: oldCanarySeed, signature: oldAttestation, userID: userID,
                    credentialID: credentialID, ecdhPublicKey: ecdh, mlkemPublicKey: mlkem
                  ) else { throw DeviceTrustError.invalidRotationTarget }
            anchor = try DeviceApprovalCrypto.canonicalize(DeviceApprovalAnchor(userID: userID, deviceID: credentialID, ecdhPublicKey: ecdh, mlkemPublicKey: mlkem))
        } catch {
            if dropInvalid { return nil }
            throw error
        }
        guard let ecdhData = Data(base64Encoded: anchor.ecdhPublicKey),
              let mlkemData = Data(base64Encoded: anchor.mlkemPublicKey) else { throw DeviceTrustError.invalidRotationTarget }
        return PasskeyRotationMaterial(
            credentialID: credentialID, ecdhPublicKey: anchor.ecdhPublicKey, mlkemPublicKey: anchor.mlkemPublicKey,
            wrappedAK: try ThunderboltCrypto.wrapAK(newAK, recipientEcdhPublicKey: ecdhData, recipientMLKEMPublicKey: mlkemData, primaryKeyID: primaryID, keyVersion: keyVersion),
            attestation: try ThunderboltCrypto.signPasskeyAttestation(canary: newCanary, userID: userID, credentialID: credentialID, ecdhPublicKey: anchor.ecdhPublicKey, mlkemPublicKey: anchor.mlkemPublicKey)
        )
    }

    private static func keyIDOrder(_ lhs: String, _ rhs: String) -> Bool {
        if lhs == "v1" { return false }
        if rhs == "v1" { return true }
        return (UInt64(lhs) ?? UInt64.max) < (UInt64(rhs) ?? UInt64.max)
    }

    private static func nextPrimaryKeyID(existing: Set<String>) throws -> String {
        var candidate: UInt64 = 0
        for keyID in existing.compactMap({ UInt64($0) }).sorted() {
            if keyID == candidate { candidate += 1 }
            if keyID > candidate { break }
        }
        guard candidate <= 999_999_999_999_999 else { throw DeviceTrustError.incompleteMetadata }
        return String(candidate)
    }

    func acknowledgeRecoveryPhrase() throws {
        guard let owner, var record else { return }
        record.recoveryPhrase = nil
        try vault.save(record, server: owner.server, userID: owner.userID)
        self.record = record
    }

    func markPrototypeMigrated() throws {
        guard let owner, var record else { return }
        record.migratedPrototype = true
        try vault.save(record, server: owner.server, userID: owner.userID)
        self.record = record
    }

    func suspend() async {
        lifetime = UUID()
        managementOperation = nil
        state = .idle
        approvalCode = nil
        localApprovalSession = nil
        pendingApprovalAttempts.removeAll()
        record = nil
        lockoutPendingDeviceIDs = []
        owner = nil
        await dataKeys.clear()
    }

    private func assertCurrent(_ epoch: UUID) throws {
        guard epoch == lifetime, !Task.isCancelled else { throw CancellationError() }
    }

    private func deviceAnchor(_ record: NativeDeviceRecord, userID: String) throws -> DeviceApprovalAnchor {
        DeviceApprovalAnchor(userID: userID, deviceID: record.id, ecdhPublicKey: try record.keys.ecdhPublicKeyBase64, mlkemPublicKey: record.keys.mlkemPublicKeyBase64)
    }

    private func isHex(_ value: String, length: Int) -> Bool {
        value.utf8.count == length && value.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
    }
}
