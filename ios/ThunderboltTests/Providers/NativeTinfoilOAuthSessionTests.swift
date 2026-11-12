/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import XCTest
import PowerSync
@testable import Thunderbolt

final class NativeTinfoilOAuthSessionTests: XCTestCase {
    func testRefreshesBoundProviderConnectionAndReusesRotatedToken() async throws {
        let store = makeStore()
        let binding = #"["tinfoil","oauth",null]"#
        try await store.writeTransaction([
            modelMutation(connectionID: "oauth:tinfoil"),
            NativeSyncMutation(table: "provider_connections", id: "oauth:tinfoil", values: [
                "provider": .text("tinfoil"), "name": .text("Tinfoil"), "url": .null,
                "auth_method": .text("oauth"), "enabled": .integer(1), "user_id": .text("user-1"),
            ]),
        ])
        try await store.write(table: "provider_connection_secrets", id: "oauth:tinfoil", values: [
            "binding": .text(binding),
            "credentials": .text(#"{"access_token":"expired","refresh_token":"refresh-1","expires_at":1000,"authorizationId":"grant-1"}"#),
        ])
        let refresher = FakeRefresher(tokens: NativeTinfoilOAuthTokens(
            accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 3600
        ))
        let session = NativeTinfoilOAuthSession(store: store, refresher: refresher, now: { 10 })

        let refreshed = try await session.accessToken(modelID: "model-1")
        let reused = try await session.accessToken(modelID: "model-1")
        XCTAssertEqual(refreshed, "rotated-access")
        XCTAssertEqual(reused, "rotated-access")
        let refreshCalls = await refresher.callCount()
        XCTAssertEqual(refreshCalls, 1)

        let savedValue = try await store.read(table: "provider_connection_secrets", id: "oauth:tinfoil")
        let saved = try XCTUnwrap(savedValue)
        let raw = try XCTUnwrap(text(saved.values["credentials"]))
        let credentials = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        XCTAssertEqual(credentials["access_token"] as? String, "rotated-access")
        XCTAssertEqual(credentials["refresh_token"] as? String, "rotated-refresh")
        XCTAssertEqual(credentials["authorizationId"] as? String, "grant-1")
        XCTAssertEqual((credentials["expires_at"] as? NSNumber)?.doubleValue, 3_610_000)
        XCTAssertNil(credentials["reauth_required"])
    }

    func testRefreshesLegacyIntegrationSecretAndMarksInvalidGrantForReauthorization() async throws {
        let store = makeStore()
        try await store.write(table: "models", id: "model-1", values: [
            "provider": .text("tinfoil"), "name": .text("Private"), "model": .text("private-model"),
            "is_system": .integer(0), "enabled": .integer(1), "is_confidential": .integer(1),
            "user_id": .text("user-1"),
        ])
        try await store.write(table: "models_secrets", id: "model-1", values: [
            "api_key": .text("expired"), "oauth_provider": .text("tinfoil"), "provider_default": .integer(1),
        ])
        try await store.write(table: "integrations_secrets", id: "tinfoil", values: [
            "credentials": .text(#"{"access_token":"expired","refresh_token":"spent","expires_at":1000}"#),
            "enabled": .integer(1),
        ])
        let session = NativeTinfoilOAuthSession(
            store: store,
            refresher: FakeRefresher(error: NativeTinfoilOAuthError.reauthorizationRequired),
            now: { 10 }
        )

        do {
            _ = try await session.accessToken(modelID: "model-1")
            XCTFail("An invalid grant requires reauthorization")
        } catch let error as NativeTinfoilOAuthError {
            XCTAssertEqual(error, .reauthorizationRequired)
        }

        let savedValue = try await store.read(table: "integrations_secrets", id: "tinfoil")
        let saved = try XCTUnwrap(savedValue)
        let raw = try XCTUnwrap(text(saved.values["credentials"]))
        let credentials = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        XCTAssertEqual(credentials["reauth_required"] as? Bool, true)
    }

    func testRejectsCredentialWhoseConnectionBindingChanged() async throws {
        let store = makeStore()
        try await store.writeTransaction([
            modelMutation(connectionID: "oauth:tinfoil"),
            NativeSyncMutation(table: "provider_connections", id: "oauth:tinfoil", values: [
                "provider": .text("tinfoil"), "name": .text("Tinfoil"), "url": .text("https://other.example"),
                "auth_method": .text("oauth"), "enabled": .integer(1), "user_id": .text("user-1"),
            ]),
        ])
        try await store.write(table: "provider_connection_secrets", id: "oauth:tinfoil", values: [
            "binding": .text(#"["tinfoil","oauth",null]"#),
            "credentials": .text(#"{"access_token":"token","refresh_token":"refresh","expires_at":9999999999999}"#),
        ])
        let session = NativeTinfoilOAuthSession(store: store, now: { 10 })

        do {
            _ = try await session.accessToken(modelID: "model-1")
            XCTFail("A changed URL invalidates the approved credential binding")
        } catch let error as NativeTinfoilOAuthError {
            XCTAssertEqual(error, .credentialUnavailable)
        }
    }

    private func makeStore() -> NativeSyncStore {
        let database = PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:")
        return NativeSyncStore(database: database, ownerID: "user-1", codec: TestCodec(), trustedDevice: { true })
    }

    private func modelMutation(connectionID: String) -> NativeSyncMutation {
        NativeSyncMutation(table: "models", id: "model-1", values: [
            "provider": .text("tinfoil"), "name": .text("Private"), "model": .text("private-model"),
            "provider_connection_id": .text(connectionID), "is_system": .integer(0),
            "enabled": .integer(1), "is_confidential": .integer(1), "user_id": .text("user-1"),
        ])
    }

    private func text(_ value: NativeSyncValue?) -> String? {
        guard case .text(let text)? = value else { return nil }
        return text
    }
}

private actor FakeRefresher: NativeTinfoilOAuthRefreshing {
    private let tokens: NativeTinfoilOAuthTokens?
    private let error: NativeTinfoilOAuthError?
    private var calls = 0

    init(tokens: NativeTinfoilOAuthTokens? = nil, error: NativeTinfoilOAuthError? = nil) {
        self.tokens = tokens
        self.error = error
    }

    func refresh(refreshToken: String) async throws -> NativeTinfoilOAuthTokens {
        calls += 1
        if let error { throw error }
        guard let tokens else { throw NativeTinfoilOAuthError.refreshFailed }
        return tokens
    }

    func callCount() -> Int { calls }
}

private struct TestCodec: NativeSyncRowCodec {
    func isEncryptionConfigured() async throws -> Bool { true }
    func isReadyForSync() async throws -> Bool { true }
    func encode(_ plaintext: String, context: E2EEContext) async throws -> String { "__enc:v2:\(plaintext)" }
    func decode(_ encoded: String, context: E2EEContext?) async throws -> String { String(encoded.dropFirst("__enc:v2:".count)) }
    func isEncryptedValue(_ value: String) -> Bool { value.hasPrefix("__enc:") }
    func isValidV2Ciphertext(_ value: String) -> Bool { value.hasPrefix("__enc:v2:") }
}
