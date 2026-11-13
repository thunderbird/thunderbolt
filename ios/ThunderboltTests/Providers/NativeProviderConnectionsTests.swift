/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
import PowerSync
@testable import Thunderbolt

final class NativeProviderConnectionsTests: XCTestCase {
    func testAPIKeyStaysInLocalSecretRowAndConnectionIsBound() async throws {
        let store = makeStore()
        let repository = NativeProviderConnectionRepository(store: store, ownerID: "user-1")
        let id = try await repository.saveAPIKey(
            provider: .custom,
            name: "Local endpoint",
            url: "http://localhost:11434/v1/",
            apiKey: "local-secret"
        )

        let connections = try await repository.load()
        XCTAssertEqual(connections.count, 1)
        XCTAssertEqual(connections[0].id, id)
        XCTAssertEqual(connections[0].url, "http://localhost:11434/v1")
        XCTAssertTrue(connections[0].connected)

        let syncedValue = try await store.read(table: "provider_connections", id: id)
        let synced = try XCTUnwrap(syncedValue)
        XCTAssertFalse(synced.values.values.contains(.text("local-secret")))
        let localValue = try await store.read(table: "provider_connection_secrets", id: id)
        let local = try XCTUnwrap(localValue)
        guard case .text(let json)? = local.values["credentials"] else { return XCTFail("Credentials are local-only") }
        XCTAssertTrue(json.contains("local-secret"))
    }

    func testDisconnectRevokesOnlyLocalBindingAndRemoveSoftDeletesRow() async throws {
        let store = makeStore()
        let repository = NativeProviderConnectionRepository(store: store, ownerID: "user-1")
        let id = try await repository.saveAPIKey(provider: .openAI, name: "Work", url: nil, apiKey: "secret")

        try await repository.disconnect(id: id)
        let disconnected = try await repository.load()
        XCTAssertFalse(disconnected[0].connected)
        let secretValue = try await store.read(table: "provider_connection_secrets", id: id)
        let secret = try XCTUnwrap(secretValue)
        XCTAssertEqual(secret.values["binding"], .null)

        try await repository.remove(id: id)
        let afterRemoval = try await repository.load()
        XCTAssertTrue(afterRemoval.isEmpty)
        let tombstone = try await store.read(table: "provider_connections", id: id)
        XCTAssertNotNil(tombstone)
    }

    func testTinfoilOAuthCredentialUsesExistingConnectionContract() async throws {
        let store = makeStore()
        let repository = NativeProviderConnectionRepository(store: store, ownerID: "user-1")
        try await repository.saveTinfoilOAuth(
            NativeTinfoilOAuthTokens(accessToken: "access", refreshToken: "refresh", expiresIn: 3600),
            authorizationID: "grant"
        )

        let value = try await store.read(table: "provider_connections", id: "oauth:tinfoil")
        let row = try XCTUnwrap(value)
        XCTAssertEqual(row.values["provider"], .text("tinfoil"))
        XCTAssertEqual(row.values["auth_method"], .text("oauth"))
        XCTAssertEqual(row.values["enabled"], .integer(1))
        let connections = try await repository.load()
        XCTAssertTrue(connections[0].connected)
    }

    func testRejectsMissingRequiredAPIKeyAndInsecureRemoteHTTP() async throws {
        let repository = NativeProviderConnectionRepository(store: makeStore(), ownerID: "user-1")
        do {
            _ = try await repository.saveAPIKey(provider: .openAI, name: "OpenAI", url: nil, apiKey: " ")
            XCTFail("API key is required for OpenAI")
        } catch let error as NativeProviderConnectionError {
            XCTAssertEqual(error, .missingAPIKey)
        }
        do {
            _ = try await repository.saveAPIKey(provider: .custom, name: "Remote", url: "http://models.example/v1", apiKey: "")
            XCTFail("Remote HTTP is insecure")
        } catch let error as NativeProviderConnectionError {
            XCTAssertEqual(error, .invalidURL)
        }
    }

    private func makeStore() -> NativeSyncStore {
        NativeSyncStore(
            database: PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:"),
            ownerID: "user-1",
            codec: ProviderTestCodec(),
            trustedDevice: { true }
        )
    }
}

private struct ProviderTestCodec: NativeSyncRowCodec {
    func isEncryptionConfigured() async throws -> Bool { true }
    func isReadyForSync() async throws -> Bool { true }
    func encode(_ plaintext: String, context: E2EEContext) async throws -> String { "__enc:v2:\(plaintext)" }
    func decode(_ encoded: String, context: E2EEContext?) async throws -> String { String(encoded.dropFirst("__enc:v2:".count)) }
    func isEncryptedValue(_ value: String) -> Bool { value.hasPrefix("__enc:") }
    func isValidV2Ciphertext(_ value: String) -> Bool { value.hasPrefix("__enc:v2:") }
}
