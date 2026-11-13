/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

/// Orchestrates WebAuthn ceremonies with the account-key rotation and virtual
/// device paths. Keeping the PRF result in this call chain prevents it from being
/// persisted or sent in any request body.
@MainActor
final class NativePasskeyCoordinator {
    private let api: NativePasskeyAPI

    init(client: CloudClient) {
        api = NativePasskeyAPI(client: client)
    }

    func authenticate() async throws -> CloudSession {
        try await api.authenticate()
    }

    func registerForSync(session: CloudSession, deviceCoordinator: DeviceCoordinator, client: CloudClient) async throws {
        guard deviceCoordinator.state == .ready else { throw DeviceTrustError.incompleteMetadata }
        guard let metadata = try await client.encryptionMetadata(token: session.token),
              metadata.schemeVersion == 2, metadata.passkeyCredentialID == nil else {
            throw CloudError.http(409, nativeString( "A passkey sync slot is already configured for this account."))
        }
        guard try await api.list(token: session.token).isEmpty else {
            throw CloudError.http(409, nativeString( "This account already has a passkey."))
        }

        let registration = try await api.register(
            token: session.token, userID: session.user.id, userName: session.user.name
        )
        let prfOutput: Data
        if let registrationOutput = registration.prfOutput {
            prfOutput = registrationOutput
        } else {
            prfOutput = try await api.unlockPRF(credentialID: registration.credentialID)
        }
        do {
            try await deviceCoordinator.enrollPasskeySlot(
                credentialID: registration.credentialID, prfOutput: prfOutput,
                client: client, token: session.token
            )
        } catch {
            // A lost rotation response may still have committed the virtual slot.
            // Delete the sign-in credential only when the server proves it was not
            // committed; if reconciliation is unavailable, preserve recoverability.
            if let metadata = try? await client.encryptionMetadata(token: session.token),
               metadata.passkeyCredentialID != registration.credentialID,
               let passkeys = try? await api.list(token: session.token),
               let record = passkeys.first(where: { $0.credentialID == registration.credentialID }) {
                try? await api.delete(recordID: record.id, token: session.token)
            }
            throw error
        }
    }

    func unlockSync(
        credentialID: String,
        session: CloudSession,
        server: String,
        deviceCoordinator: DeviceCoordinator,
        client: CloudClient
    ) async throws {
        let prfOutput = try await api.unlockPRF(credentialID: credentialID)
        try await deviceCoordinator.recoverWithPasskey(
            credentialID: credentialID, prfOutput: prfOutput,
            session: session, server: server, client: client
        )
    }

    /// Clears the encrypted-sync slot first, then removes the sign-in credential.
    /// If credential deletion fails, the remaining passkey can still sign in but
    /// no longer unlocks the account's encryption key.
    func remove(
        credentialID: String,
        session: CloudSession,
        deviceCoordinator: DeviceCoordinator,
        client: CloudClient
    ) async throws {
        let passkeys = try await api.list(token: session.token)
        guard let passkey = passkeys.first(where: { $0.credentialID == credentialID }) else {
            throw CloudError.invalidResponse
        }
        if let metadata = try await client.encryptionMetadata(token: session.token),
           metadata.passkeyCredentialID == credentialID {
            try await deviceCoordinator.removePasskeySlot(
                credentialID: credentialID, client: client, token: session.token
            )
        }
        try await api.delete(recordID: passkey.id, token: session.token)
    }

    func list(session: CloudSession) async throws -> [NativePasskeyRecord] {
        try await api.list(token: session.token)
    }
}
