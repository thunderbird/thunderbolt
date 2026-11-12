/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

@MainActor
final class DeviceIntegrationTests: XCTestCase {
    func testBootstrapRebindAndEncryptedPowerSyncReplication() async throws {
        guard let endpoint = ProcessInfo.processInfo.environment["THUNDERBOLT_INTEGRATION_URL"], !endpoint.isEmpty else {
            throw XCTSkip("Run ios/scripts/test-sync.sh against the isolated local PowerSync stack.")
        }
        let server = try ServerAddress.normalize(endpoint)
        guard server.host == "localhost" || server.host == "127.0.0.1" else {
            XCTFail("This test only creates accounts on a local backend")
            return
        }
        let client = CloudClient(baseURL: server)
        let email = "native-sync-\(UUID().uuidString.lowercased())@thunderbolt.io"
        let challenge = try await client.sendCode(email: email)
        let session = try await client.verifyCode(email: email, code: "12345678", challenge: XCTUnwrap(challenge))
        let vault = DeviceVault(service: "thunderbolt.native.integration.\(UUID())")
        defer { try? vault.remove(server: server.absoluteString, userID: session.user.id) }

        let device = DeviceCoordinator(vault: vault)
        try await device.prepare(session: session, server: server.absoluteString, client: client, deviceName: "Native integration test")
        XCTAssertEqual(device.state, .ready)
        let original = try XCTUnwrap(device.record)
        XCTAssertEqual(original.recoveryPhrase?.split(separator: " ").count, 24)
        XCTAssertEqual(original.dataKeys["0"]?.count, 32)
        XCTAssertNil(original.pendingBootstrap)

        // A new coordinator and a newly issued login simulate relaunch + expired session.
        await device.suspend()
        try await client.signOut(token: session.token)
        // The real waitlist endpoint has a 15-second per-email resend cooldown.
        try await Task.sleep(for: .seconds(15))
        let nextChallenge = try await client.sendCode(email: email)
        let nextSession = try await client.verifyCode(email: email, code: "12345678", challenge: XCTUnwrap(nextChallenge))
        let resumed = DeviceCoordinator(vault: vault)
        try await resumed.prepare(session: nextSession, server: server.absoluteString, client: client, deviceName: "Native integration test")
        XCTAssertEqual(resumed.state, .ready)
        XCTAssertEqual(resumed.record?.id, original.id)
        XCTAssertEqual(resumed.record?.dataKeys["0"], original.dataKeys["0"])

        let codec = ThunderboltColumnCodec(keys: resumed.dataKeys)
        let keys = resumed.dataKeys
        let first = NativeSyncStore.open(ownerID: session.user.id, codec: codec,
            trustedDevice: { await keys.isTrusted() }, dbFilename: "native-integration-a-\(UUID()).sqlite")
        let second = NativeSyncStore.open(ownerID: session.user.id, codec: codec,
            trustedDevice: { await keys.isTrusted() }, dbFilename: "native-integration-b-\(UUID()).sqlite")
        let transport = NativePowerSyncHTTPTransport(backendURL: server, accountID: session.user.id, deviceName: "Native integration test",
            appVersion: "0.1.164", sessionToken: { nextSession.token }, deviceID: { original.id })
        let readiness = try await first.connect(using: NativePowerSyncConnector(store: first, transport: transport))
        XCTAssertEqual(readiness, .ready)
        _ = try await second.connect(using: NativePowerSyncConnector(store: second, transport: transport))

        let conversation = Conversation(title: "Encrypted native sync fixture", messages: [ChatMessage(role: .user, text: "Private fixture 日本語")])
        let thread = ConversationRecords.thread(conversation, userID: session.user.id)
        let message = try ConversationRecords.message(conversation.messages[0], threadID: conversation.id, userID: session.user.id)
        try await first.writeTransaction([thread, message].map { NativeSyncMutation(table: $0.table, id: $0.id, values: $0.values) })
        let deadline = Date().addingTimeInterval(40)
        var received: NativeSyncRow?
        while Date() < deadline {
            received = try await second.read(table: "chat_messages", id: message.id)
            if received != nil { break }
            try await Task.sleep(for: .milliseconds(250))
        }
        XCTAssertEqual(received?.values["content"], .text("Private fixture 日本語"))
        try await first.disconnectAndClear()
        try await second.disconnectAndClear()
        await resumed.suspend()
    }
}
