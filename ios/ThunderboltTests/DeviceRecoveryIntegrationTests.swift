/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import CryptoKit
import Foundation
import XCTest
@testable import Thunderbolt

@MainActor
final class DeviceRecoveryIntegrationTests: XCTestCase {
    func testTrustedDeviceApprovesTargetAndPendingDeviceAdoptsBoundEnvelope() async throws {
        let user = CloudUser(id: "approval-test-account", name: "Test", email: "approval@example.test")
        let session = CloudSession(token: "test-token", user: user)
        let serverURL = "http://localhost:8000/v1"
        let firstVault = DeviceVault(service: "net.thunderbolt.tests.approval.first.\(UUID().uuidString)")
        let secondVault = DeviceVault(service: "net.thunderbolt.tests.approval.second.\(UUID().uuidString)")
        let firstClient = flowClient(serverURL: serverURL)
        let secondClient = flowClient(serverURL: serverURL)
        let first = DeviceCoordinator(vault: firstVault)
        let second = DeviceCoordinator(vault: secondVault)
        let transport = DeviceFlowURLProtocol.transport
        defer {
            transport.reset()
            try? firstVault.remove(server: serverURL, userID: user.id)
            try? secondVault.remove(server: serverURL, userID: user.id)
        }

        try await first.prepare(session: session, server: serverURL, client: firstClient, deviceName: "Approver")
        try await second.prepare(session: session, server: serverURL, client: secondClient, deviceName: "Pending")
        XCTAssertEqual(second.state, .awaitingApproval)
        let target = try XCTUnwrap(second.record)
        let anchor = DeviceApprovalAnchor(
            userID: user.id, deviceID: target.id,
            ecdhPublicKey: try target.keys.ecdhPublicKeyBase64,
            mlkemPublicKey: target.keys.mlkemPublicKeyBase64
        )

        _ = try await second.startApprovalSession(client: secondClient, token: session.token)
        _ = try await first.challengePendingDevice(anchor: anchor, client: firstClient, token: session.token)
        let visibleCode = try await second.pollApprovalCode(client: secondClient, token: session.token)
        XCTAssertNotNil(visibleCode)
        let promptValue = try await first.pollPendingDeviceCode(deviceID: target.id, client: firstClient, token: session.token)
        let prompt = try XCTUnwrap(promptValue)
        let code = try XCTUnwrap(second.approvalCode)
        XCTAssertTrue(prompt.options.contains(code))
        let pendingDeviceTrusted = await second.dataKeys.isTrusted()
        XCTAssertFalse(pendingDeviceTrusted)
        let wrongCode = try XCTUnwrap(prompt.options.first { $0 != code })
        do {
            try await first.approvePendingDevice(deviceID: target.id, selectedCode: wrongCode, client: firstClient, token: session.token)
            XCTFail("A wrong short code must not approve the pending device")
        } catch DeviceTrustError.approvalChanged {}
        let approverRemainsTrusted = await first.dataKeys.isTrusted()
        XCTAssertTrue(approverRemainsTrusted)
        try await first.approvePendingDevice(deviceID: target.id, selectedCode: code, client: firstClient, token: session.token)

        let completedCode = try await second.pollApprovalCode(client: secondClient, token: session.token)
        XCTAssertNil(completedCode)
        XCTAssertEqual(second.state, .ready)
        XCTAssertEqual(second.record?.accountKey, first.record?.accountKey)
        XCTAssertEqual(second.record?.dataKeys, first.record?.dataKeys)
    }

    func testRecoveryPhraseChangeRotatesAccountKeyButKeepsDEKZeroAndReplacesOldPhrase() async throws {
        let user = CloudUser(id: "phrase-rotation-account", name: "Test", email: "rotation@example.test")
        let session = CloudSession(token: "test-token", user: user)
        let serverURL = "http://localhost:8000/v1"
        let firstVault = DeviceVault(service: "net.thunderbolt.tests.rotation.first.\(UUID().uuidString)")
        let secondVault = DeviceVault(service: "net.thunderbolt.tests.rotation.second.\(UUID().uuidString)")
        let firstClient = flowClient(serverURL: serverURL)
        let secondClient = flowClient(serverURL: serverURL)
        let first = DeviceCoordinator(vault: firstVault)
        let second = DeviceCoordinator(vault: secondVault)
        let transport = DeviceFlowURLProtocol.transport
        defer {
            transport.reset()
            try? firstVault.remove(server: serverURL, userID: user.id)
            try? secondVault.remove(server: serverURL, userID: user.id)
        }

        try await first.prepare(session: session, server: serverURL, client: firstClient, deviceName: "First")
        let oldPhrase = try XCTUnwrap(first.record?.recoveryPhrase)
        let originalDEK0 = first.record?.dataKeys["0"]
        try first.acknowledgeRecoveryPhrase()
        transport.setRequiredStepUpCode("246810")
        try await first.requestRecoveryPhraseChangeCode(client: firstClient, token: session.token)
        let newPhrase = try await first.changeRecoveryPhrase(stepUpOTP: "246810", client: firstClient, token: session.token)
        XCTAssertNotEqual(newPhrase, oldPhrase)
        XCTAssertEqual(first.record?.keyVersion, 2)
        XCTAssertEqual(first.record?.primaryKeyID, "0")
        XCTAssertEqual(first.record?.dataKeys["0"], originalDEK0)

        try await second.prepare(session: session, server: serverURL, client: secondClient, deviceName: "Second")
        do {
            try await second.recoverWithPhrase(phrase: oldPhrase, session: session, server: serverURL, client: secondClient)
            XCTFail("Old recovery phrase must stop working after the rotation")
        } catch DeviceTrustError.invalidRecoveryPhrase {}
        XCTAssertNil(transport.envelope(for: try XCTUnwrap(second.record?.id)))
        try await second.recoverWithPhrase(phrase: newPhrase, session: session, server: serverURL, client: secondClient)
        XCTAssertEqual(second.record?.accountKey, first.record?.accountKey)
        XCTAssertEqual(second.record?.dataKeys["0"], first.record?.dataKeys["0"])
    }

    func testRevocationCutsAccessBeforeRotationAndLockoutCanResume() async throws {
        let user = CloudUser(id: "revocation-test-account", name: "Test", email: "revoke@example.test")
        let session = CloudSession(token: "test-token", user: user)
        let serverURL = "http://localhost:8000/v1"
        let firstVault = DeviceVault(service: "net.thunderbolt.tests.revocation.first.\(UUID().uuidString)")
        let secondVault = DeviceVault(service: "net.thunderbolt.tests.revocation.second.\(UUID().uuidString)")
        let firstClient = flowClient(serverURL: serverURL)
        let secondClient = flowClient(serverURL: serverURL)
        let first = DeviceCoordinator(vault: firstVault)
        let second = DeviceCoordinator(vault: secondVault)
        let transport = DeviceFlowURLProtocol.transport
        defer {
            transport.reset()
            try? firstVault.remove(server: serverURL, userID: user.id)
            try? secondVault.remove(server: serverURL, userID: user.id)
        }

        try await first.prepare(session: session, server: serverURL, client: firstClient, deviceName: "First")
        let phrase = try XCTUnwrap(first.record?.recoveryPhrase)
        try first.acknowledgeRecoveryPhrase()
        try await second.prepare(session: session, server: serverURL, client: secondClient, deviceName: "Second")
        try await second.recoverWithPhrase(phrase: phrase, session: session, server: serverURL, client: secondClient)
        let targetID = try XCTUnwrap(second.record?.id)
        let context = E2EEContext(table: "chat_messages", column: "content", rowID: "pre-revocation")
        let firstCodec = ThunderboltColumnCodec(keys: first.dataKeys)
        let secondCodec = ThunderboltColumnCodec(keys: second.dataKeys)
        let beforeRevocation = try await firstCodec.encode("old content", context: context)

        transport.rejectNextRotation()
        let lockoutPending = try await first.revokeDevice(deviceID: targetID, client: firstClient, token: session.token)
        XCTAssertTrue(lockoutPending)
        XCTAssertNil(transport.envelope(for: targetID))
        XCTAssertEqual(first.lockoutPendingDeviceIDs, [targetID])

        try await first.finishDeviceLockout(client: firstClient, token: session.token)
        XCTAssertTrue(first.lockoutPendingDeviceIDs.isEmpty)
        XCTAssertEqual(first.record?.keyVersion, 2)
        XCTAssertEqual(first.record?.primaryKeyID, "1")
        XCTAssertEqual(first.record?.dataKeys["0"], second.record?.dataKeys["0"])
        XCTAssertEqual(first.record?.dataKeys.count, 2)
        let afterRevocation = try await firstCodec.encode("new content", context: E2EEContext(table: "chat_messages", column: "content", rowID: "post-revocation"))
        XCTAssertTrue(afterRevocation.hasPrefix("__enc:v2:1:"))
        let existingContent = try await firstCodec.decode(beforeRevocation, context: context)
        let revokedDeviceContent = try await secondCodec.decode(afterRevocation, context: E2EEContext(table: "chat_messages", column: "content", rowID: "post-revocation"))
        XCTAssertEqual(existingContent, "old content")
        XCTAssertEqual(revokedDeviceContent, afterRevocation)

        do {
            try await second.prepare(session: session, server: serverURL, client: secondClient, deviceName: "Second")
            XCTFail("A revoked device must not regain a trusted server session")
        } catch CloudError.http(403, _) {}
        XCTAssertEqual(second.state, .offline)
        let secondTrusted = await second.dataKeys.isTrusted()
        XCTAssertFalse(secondTrusted)
    }

    func testRotationRejectsValidSameEpochForeignDEKZeroBeforePosting() async throws {
        let user = CloudUser(id: "fork-test-account", name: "Test", email: "fork@example.test")
        let session = CloudSession(token: "test-token", user: user)
        let serverURL = "http://localhost:8000/v1"
        let vault = DeviceVault(service: "net.thunderbolt.tests.fork.\(UUID().uuidString)")
        let client = flowClient(serverURL: serverURL)
        let coordinator = DeviceCoordinator(vault: vault)
        let transport = DeviceFlowURLProtocol.transport
        defer {
            transport.reset()
            try? vault.remove(server: serverURL, userID: user.id)
        }

        try await coordinator.prepare(session: session, server: serverURL, client: client, deviceName: "First")
        let accountKey = try XCTUnwrap(coordinator.record?.accountKey)
        let localDEK0 = try XCTUnwrap(coordinator.record?.dataKeys["0"])
        let foreignDEK0 = try ThunderboltCrypto.randomBytes(count: 32)
        transport.replaceWrappedDEK0(try ThunderboltCrypto.wrapDEK(foreignDEK0, accountKey: accountKey, keyID: "0"))

        do {
            _ = try await coordinator.changeRecoveryPhrase(stepUpOTP: "123456", client: client, token: session.token)
            XCTFail("A valid same-epoch wrapper for a substituted immutable DEK 0 must be rejected")
        } catch DeviceTrustError.replacedAccount {}
        XCTAssertEqual(coordinator.record?.dataKeys["0"], localDEK0)
        XCTAssertEqual(transport.rotationRequestCount, 0)
    }

    func testRotationRejectsSameEpochForeignAccountKeyEnvelopeBeforePosting() async throws {
        let user = CloudUser(id: "envelope-fork-test-account", name: "Test", email: "fork@example.test")
        let session = CloudSession(token: "test-token", user: user)
        let serverURL = "http://localhost:8000/v1"
        let vault = DeviceVault(service: "net.thunderbolt.tests.envelope-fork.\(UUID().uuidString)")
        let client = flowClient(serverURL: serverURL)
        let coordinator = DeviceCoordinator(vault: vault)
        let transport = DeviceFlowURLProtocol.transport
        defer {
            transport.reset()
            try? vault.remove(server: serverURL, userID: user.id)
        }

        try await coordinator.prepare(session: session, server: serverURL, client: client, deviceName: "First")
        let local = try XCTUnwrap(coordinator.record)
        let foreignAK = try ThunderboltCrypto.generateAccountKey()
        let forgedForSameEpoch = try ThunderboltCrypto.wrapAK(foreignAK, recipient: local.keys, primaryKeyID: "0", keyVersion: 1)
        transport.replaceEnvelope(for: local.id, with: forgedForSameEpoch)

        do {
            _ = try await coordinator.changeRecoveryPhrase(stepUpOTP: "123456", client: client, token: session.token)
            XCTFail("A same-epoch envelope for another account key must be rejected")
        } catch DeviceTrustError.replacedAccount {}
        XCTAssertEqual(coordinator.record?.accountKey, local.accountKey)
        XCTAssertEqual(transport.rotationRequestCount, 0)
    }

    func testSecondDeviceRecoversOnlyFromItsSavedPhraseAndRejectsMetadataSubstitution() async throws {
        let user = CloudUser(id: "recovery-test-account", name: "Test", email: "recovery@example.test")
        let session = CloudSession(token: "test-token", user: user)
        let serverURL = "http://localhost:8000/v1"
        let firstVault = DeviceVault(service: "net.thunderbolt.tests.recovery.first.\(UUID().uuidString)")
        let secondVault = DeviceVault(service: "net.thunderbolt.tests.recovery.second.\(UUID().uuidString)")
        let firstClient = flowClient(serverURL: serverURL)
        let secondClient = flowClient(serverURL: serverURL)
        let first = DeviceCoordinator(vault: firstVault)
        let second = DeviceCoordinator(vault: secondVault)
        let transport = DeviceFlowURLProtocol.transport

        defer {
            transport.reset()
            try? firstVault.remove(server: serverURL, userID: user.id)
            try? secondVault.remove(server: serverURL, userID: user.id)
        }

        try await first.prepare(session: session, server: serverURL, client: firstClient, deviceName: "First")
        XCTAssertEqual(first.state, .ready)
        let phrase = try XCTUnwrap(first.record?.recoveryPhrase)

        try await second.prepare(session: session, server: serverURL, client: secondClient, deviceName: "Second")
        XCTAssertEqual(second.state, .awaitingApproval)
        do {
            try await second.recoverWithPhrase(phrase: "not a valid recovery phrase", session: session, server: serverURL, client: secondClient)
            XCTFail("Wrong recovery phrase must be rejected")
        } catch {
            XCTAssertNil(second.record?.accountKey)
        }
        XCTAssertNil(transport.envelope(for: second.record!.id))

        transport.setSigningKeyOverride(Data([0x01]).base64EncodedString())
        do {
            try await second.recoverWithPhrase(phrase: phrase, session: session, server: serverURL, client: secondClient)
            XCTFail("A substituted signing key must be rejected")
        } catch DeviceTrustError.replacedAccount {}
        XCTAssertNil(transport.envelope(for: second.record!.id))

        transport.setSigningKeyOverride(nil)
        transport.setKeyVersionOverride(99)
        do {
            try await second.recoverWithPhrase(phrase: phrase, session: session, server: serverURL, client: secondClient)
            XCTFail("A substituted key epoch must be rejected")
        } catch DeviceTrustError.rollback {}
        XCTAssertNil(transport.envelope(for: second.record!.id))

        transport.setKeyVersionOverride(nil)
        try await second.recoverWithPhrase(phrase: phrase, session: session, server: serverURL, client: secondClient)
        XCTAssertEqual(second.state, .ready)
        XCTAssertEqual(second.record?.accountKey, first.record?.accountKey)
        XCTAssertEqual(second.record?.dataKeys["0"], first.record?.dataKeys["0"])

        let context = E2EEContext(table: "chat_messages", column: "content", rowID: "shared-message")
        let firstCodec = ThunderboltColumnCodec(keys: first.dataKeys)
        let secondCodec = ThunderboltColumnCodec(keys: second.dataKeys)
        let wire = try await firstCodec.encode("existing synced conversation", context: context)
        XCTAssertTrue(wire.hasPrefix("__enc:v2:0:"))
        let decoded = try await secondCodec.decode(wire, context: context)
        XCTAssertEqual(decoded, "existing synced conversation")
    }

    private func flowClient(serverURL: String) -> CloudClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeviceFlowURLProtocol.self]
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        return CloudClient(baseURL: URL(string: serverURL)!, session: URLSession(configuration: configuration))
    }
}

private final class DeviceFlowTransport: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private var registered: [String: DeviceFlowRegistration] = [:]
    private var envelopes: [String: DeviceFlowEnvelope] = [:]
    private var metadata: [String: Any]?
    private var wrappedKeys: [[String: String]] = []
    private var bindNonces: [String: String] = [:]
    private var approvalSessions: [String: DeviceFlowApprovalSession] = [:]
    private var revokedDeviceIDs: Set<String> = []
    private var lockoutPendingIDs: Set<String> = []
    private var requiredStepUpCode: String?
    private var rejectRotationCount = 0
    private var rotationRequests = 0
    private(set) var signingKeyOverride: String?
    private(set) var keyVersionOverride: Int?

    func reset() {
        lock.lock(); defer { lock.unlock() }
        registered = [:]
        envelopes = [:]
        metadata = nil
        wrappedKeys = []
        bindNonces = [:]
        approvalSessions = [:]
        revokedDeviceIDs = []
        lockoutPendingIDs = []
        requiredStepUpCode = nil
        rejectRotationCount = 0
        rotationRequests = 0
        signingKeyOverride = nil
        keyVersionOverride = nil
    }

    func setSigningKeyOverride(_ value: String?) {
        lock.lock(); defer { lock.unlock() }
        signingKeyOverride = value
    }

    func setKeyVersionOverride(_ value: Int?) {
        lock.lock(); defer { lock.unlock() }
        keyVersionOverride = value
    }

    func setRequiredStepUpCode(_ value: String?) {
        lock.lock(); defer { lock.unlock() }
        requiredStepUpCode = value
    }

    func rejectNextRotation() {
        lock.lock(); defer { lock.unlock() }
        rejectRotationCount += 1
    }

    func replaceWrappedDEK0(_ wrappedKey: String) {
        lock.lock(); defer { lock.unlock() }
        wrappedKeys = wrappedKeys.map { item in
            item["key_id"] == "0" ? ["key_id": "0", "wrapped_key": wrappedKey] : item
        }
    }

    func replaceEnvelope(for id: String, with wrappedCK: String) {
        lock.lock(); defer { lock.unlock() }
        guard let envelope = envelopes[id] else { return }
        envelopes[id] = DeviceFlowEnvelope(trusted: envelope.trusted, wrappedCK: wrappedCK, attestation: envelope.attestation)
    }

    var rotationRequestCount: Int {
        lock.lock(); defer { lock.unlock() }
        return rotationRequests
    }

    func envelope(for id: String) -> DeviceFlowEnvelope? {
        lock.lock(); defer { lock.unlock() }
        return envelopes[id]
    }

    func handle(_ request: URLRequest) throws -> (Data, Int) {
        lock.lock(); defer { lock.unlock() }
        let path = request.url?.path ?? ""
        let deviceID = request.value(forHTTPHeaderField: "X-Device-ID") ?? ""
        let body = try Self.jsonObject(request.httpBody ?? Data())
        switch (request.httpMethod ?? "GET", path) {
        case ("POST", "/v1/devices"):
            guard let id = body["deviceId"] as? String,
                  let publicKey = body["publicKey"] as? String,
                  let ecdhKey = Data(base64Encoded: publicKey),
                  let mlkemKeyText = body["mlkemPublicKey"] as? String,
                  let mlkemKey = Data(base64Encoded: mlkemKeyText) else { return (.json(#"{"error":"invalid registration"}"#), 400) }
            if revokedDeviceIDs.contains(id) { return (.json(#"{"error":"Device has been revoked"}"#), 403) }
            registered[id] = DeviceFlowRegistration(ecdhPublicKey: ecdhKey, mlkemPublicKey: mlkemKey, mlkemPublicKeyText: mlkemKeyText)
            return (.json(#"{"trusted":false,"pendingSince":"first-registration"}"#), 200)
        case ("GET", "/v1/devices/me/bind-challenge"):
            guard let registeredDevice = registered[deviceID], !revokedDeviceIDs.contains(deviceID) else { return (.json(#"{"error":"unknown device"}"#), 404) }
            let (sealed, nonce) = try Self.sealBindNonce(publicKey: registeredDevice.ecdhPublicKey)
            bindNonces[deviceID] = nonce
            return (try Self.json(["sealed": sealed, "expires_at": "2026-11-11T00:00:00Z"]), 200)
        case ("POST", "/v1/devices/me/bind"):
            guard body["deviceId"] as? String == deviceID,
                  body["nonce"] as? String == bindNonces[deviceID] else { return (.json(#"{"error":"invalid bind"}"#), 403) }
            return (.json("{}"), 200)
        case ("GET", "/v1/encryption/canary"):
            guard var payload = metadata else { return (.json(#"{"error":"not found"}"#), 404) }
            if let signingKeyOverride { payload["signing_public_key"] = signingKeyOverride }
            if let keyVersionOverride { payload["key_version"] = keyVersionOverride }
            return (try Self.json(payload), 200)
        case ("GET", "/v1/encryption/keys"):
            return (try Self.json(["keys": wrappedKeys]), 200)
        case ("GET", "/v1/encryption/envelope-targets"):
            let targets = envelopes.keys.sorted().filter { !revokedDeviceIDs.contains($0) }.compactMap { id -> [String: Any]? in
                guard let device = registered[id], let envelope = envelopes[id] else { return nil }
                return ["device_id": id, "public_key": device.ecdhPublicKey.base64EncodedString(), "mlkem_public_key": device.mlkemPublicKeyText, "attestation": envelope.attestation as Any]
            }
            return (try Self.json(["devices": targets]), 200)
        case ("GET", "/v1/encryption/lockout-pending"):
            return (try Self.json(["device_ids": lockoutPendingIDs.sorted()]), 200)
        case ("POST", "/v1/encryption/step-up/request"), ("POST", "/v1/account/deletion/step-up/request"):
            return (.json("{}"), 200)
        case ("DELETE", "/v1/account"):
            return (.json("{}"), 204)
        case ("GET", "/v1/devices/me/envelope"):
            guard let envelope = envelopes[deviceID] else { return (.json(#"{"error":"not found"}"#), 404) }
            return (try Self.json(["trusted": envelope.trusted, "wrappedCK": envelope.wrappedCK, "attestation": envelope.attestation]), 200)
        case ("GET", "/v1/encryption/challenge"):
            guard let operation = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "operation" })?.value,
                  ["approve", "revoke", "rotate"].contains(operation) else { return (.json(#"{"error":"invalid operation"}"#), 400) }
            return (.json(#"{"nonce":"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff","expires_at":"2026-11-11T00:00:00Z"}"#), 200)
        case ("POST", "/v1/devices/me/approval-session"):
            guard let sessionID = body["sessionId"] as? String,
                  let commitment = body["commitment"] as? String,
                  registered[deviceID] != nil, envelopes[deviceID] == nil else { return (.json(#"{"error":"invalid session"}"#), 409) }
            approvalSessions[deviceID] = DeviceFlowApprovalSession(sessionID: sessionID, commitment: commitment)
            return (.json("{}"), 200)
        case ("GET", "/v1/devices/me/approval-session"):
            guard let stored = approvalSessions[deviceID], envelopes[deviceID] == nil else { return (.json(#"{"error":"not found"}"#), 404) }
            return (try Self.json(stored.json), 200)
        case ("POST", "/v1/devices/me/approval-session/reveal"):
            guard var stored = approvalSessions[deviceID],
                  body["sessionId"] as? String == stored.sessionID,
                  stored.challenge != nil,
                  let reveal = body["reveal"] as? String else { return (.json(#"{"error":"invalid reveal"}"#), 409) }
            stored.reveal = reveal
            approvalSessions[deviceID] = stored
            return (.json("{}"), 200)
        default:
            if request.httpMethod == "POST", path.hasPrefix("/v1/account/devices/"), path.hasSuffix("/revoke") {
                let target = String(path.dropFirst("/v1/account/devices/".count).dropLast("/revoke".count))
                if metadata != nil {
                    guard let proof = body["proof"] as? [String: Any], try verifyProof(proof, deviceID: deviceID, operation: "revoke") else {
                        return (.json(#"{"error":"invalid revoke proof"}"#), 403)
                    }
                }
                revokedDeviceIDs.insert(target)
                lockoutPendingIDs.insert(target)
                envelopes.removeValue(forKey: target)
                return (Data(), 204)
            }
            if request.httpMethod == "POST", path == "/v1/encryption/rotate" {
                rotationRequests += 1
                guard let metadata, let proof = body["proof"] as? [String: Any],
                      try verifyProof(proof, deviceID: deviceID, operation: "rotate"),
                      let recoveryEcdh = body["recoveryEcdhPublicKey"] as? String,
                      let recoveryMLKEM = body["recoveryMlkemPublicKey"] as? String,
                      let wrappedKeys = body["wrappedKeys"] as? [[String: Any]],
                      let envelopeList = body["envelopes"] as? [[String: Any]] else {
                    return (.json(#"{"error":"invalid rotation"}"#), 403)
                }
                let recoveryChanged = recoveryEcdh != (metadata["recovery_ecdh_public_key"] as? String) || recoveryMLKEM != (metadata["recovery_mlkem_public_key"] as? String)
                if recoveryChanged, let requiredStepUpCode,
                   body["stepUpOtp"] as? String != requiredStepUpCode {
                    return (.json(#"{"error":"invalid step-up code"}"#), 403)
                }
                if rejectRotationCount > 0 {
                    rejectRotationCount -= 1
                    return (.json(#"{"error":"simulated rotation failure"}"#), 500)
                }
                let targetIDs = envelopes.keys.filter { !revokedDeviceIDs.contains($0) }.sorted()
                let submittedIDs = envelopeList.compactMap { $0["deviceId"] as? String }.sorted()
                guard targetIDs == submittedIDs else { return (.json(#"{"error":"incomplete envelope coverage"}"#), 400) }
                let newEnvelopes = try Dictionary(uniqueKeysWithValues: envelopeList.map { item -> (String, DeviceFlowEnvelope) in
                    guard let id = item["deviceId"] as? String, let wrapped = item["wrappedCK"] as? String,
                          let attestation = item["attestation"] as? String else { throw DeviceFlowFailure.invalidBody }
                    return (id, DeviceFlowEnvelope(trusted: true, wrappedCK: wrapped, attestation: attestation))
                })
                let replacementKeys = try wrappedKeys.map { item -> [String: String] in
                    guard let id = item["keyId"] as? String, let wrapped = item["wrappedKey"] as? String else { throw DeviceFlowFailure.invalidBody }
                    return ["key_id": id, "wrapped_key": wrapped]
                }
                let newPrimary = body["newPrimaryKey"] as? [String: Any]
                var updatedKeys = replacementKeys
                if let newPrimary,
                   let id = newPrimary["keyId"] as? String, let wrapped = newPrimary["wrappedKey"] as? String {
                    updatedKeys.append(["key_id": id, "wrapped_key": wrapped])
                }
                let nextVersion = (metadata["key_version"] as? Int ?? 0) + 1
                var updatedMetadata = metadata
                updatedMetadata["canary_iv"] = body["canaryIv"]
                updatedMetadata["canary_ctext"] = body["canaryCtext"]
                updatedMetadata["signing_public_key"] = body["signingPublicKey"]
                updatedMetadata["kdf_salt"] = body["kdfSalt"]
                updatedMetadata["recovery_ecdh_public_key"] = recoveryEcdh
                updatedMetadata["recovery_mlkem_public_key"] = recoveryMLKEM
                updatedMetadata["recovery_wrapped_ak"] = body["recoveryWrappedAK"]
                updatedMetadata["recovery_attestation"] = body["recoveryAttestation"]
                updatedMetadata["key_version"] = nextVersion
                if let newPrimary { updatedMetadata["primary_key_id"] = newPrimary["keyId"] }
                for key in ["passkey_credential_id", "passkey_ecdh_public_key", "passkey_mlkem_public_key", "passkey_wrapped_ak", "passkey_attestation"] {
                    updatedMetadata.removeValue(forKey: key)
                }
                if let credentialID = body["passkeyCredentialId"] as? String,
                   let ecdh = body["passkeyEcdhPublicKey"] as? String,
                   let mlkem = body["passkeyMlkemPublicKey"] as? String,
                   let wrapped = body["passkeyWrappedAK"] as? String,
                   let attestation = body["passkeyAttestation"] as? String {
                    updatedMetadata["passkey_credential_id"] = credentialID
                    updatedMetadata["passkey_ecdh_public_key"] = ecdh
                    updatedMetadata["passkey_mlkem_public_key"] = mlkem
                    updatedMetadata["passkey_wrapped_ak"] = wrapped
                    updatedMetadata["passkey_attestation"] = attestation
                }
                self.metadata = updatedMetadata
                self.wrappedKeys = updatedKeys
                self.envelopes = newEnvelopes
                lockoutPendingIDs.removeAll()
                return (try Self.json(["key_version": nextVersion]), 200)
            }
            if request.httpMethod == "GET", path.hasPrefix("/v1/devices/"), path.hasSuffix("/approval-session"),
               !path.hasPrefix("/v1/devices/me/") {
                let target = String(path.dropFirst("/v1/devices/".count).dropLast("/approval-session".count))
                guard let stored = approvalSessions[target] else { return (.json(#"{"error":"not found"}"#), 404) }
                return (try Self.json(stored.json), 200)
            }
            if request.httpMethod == "POST", path.hasPrefix("/v1/devices/"), path.hasSuffix("/approval-session/challenge") {
                let target = String(path.dropFirst("/v1/devices/".count).dropLast("/approval-session/challenge".count))
                guard var stored = approvalSessions[target],
                      body["sessionId"] as? String == stored.sessionID,
                      let challenge = body["challenge"] as? String else { return (.json(#"{"error":"invalid challenge"}"#), 409) }
                stored.challenge = challenge
                stored.challengerDeviceID = deviceID
                approvalSessions[target] = stored
                return (.json("{}"), 200)
            }
            if request.httpMethod == "POST", path.hasPrefix("/v1/devices/"), path.hasSuffix("/envelope") {
                let target = String(path.dropFirst("/v1/devices/".count).dropLast("/envelope".count))
                guard let wrappedCK = body["wrappedCK"] as? String,
                      let attestation = body["attestation"] as? String else { return (.json(#"{"error":"missing envelope"}"#), 400) }
                if metadata != nil {
                    guard let proof = body["proof"] as? [String: Any], try verifyProof(proof, deviceID: deviceID) else {
                        return (.json(#"{"error":"invalid proof"}"#), 403)
                    }
                    guard let proof = body["proof"] as? [String: Any], proof["deviceId"] as? String == deviceID else {
                        return (.json(#"{"error":"invalid approval"}"#), 403)
                    }
                    if target != deviceID {
                        guard let pending = approvalSessions[target], pending.challenge != nil, pending.reveal != nil,
                              pending.challengerDeviceID == deviceID else {
                            return (.json(#"{"error":"invalid approval"}"#), 403)
                        }
                    }
                } else {
                    guard target == deviceID,
                          let keys = body["wrappedKeys"] as? [[String: Any]] else { return (.json(#"{"error":"invalid bootstrap"}"#), 400) }
                    wrappedKeys = try keys.map { item in
                        guard let id = item["keyId"] as? String, let wrapped = item["wrappedKey"] as? String else { throw DeviceFlowFailure.invalidBody }
                        return ["key_id": id, "wrapped_key": wrapped]
                    }
                    metadata = [
                        "canary_iv": body["canaryIv"] as Any,
                        "canary_ctext": body["canaryCtext"] as Any,
                        "signing_public_key": body["signingPublicKey"] as Any,
                        "kdf_salt": body["kdfSalt"] as Any,
                        "recovery_ecdh_public_key": body["recoveryEcdhPublicKey"] as Any,
                        "recovery_mlkem_public_key": body["recoveryMlkemPublicKey"] as Any,
                        "recovery_wrapped_ak": body["recoveryWrappedAK"] as Any,
                        "recovery_attestation": body["recoveryAttestation"] as Any,
                        "key_version": 1, "primary_key_id": "0", "scheme_version": 2,
                    ]
                }
                envelopes[target] = DeviceFlowEnvelope(trusted: true, wrappedCK: wrappedCK, attestation: attestation)
                return (.json("{}"), 200)
            }
            return (.json(#"{"error":"not found"}"#), 404)
        }
    }

    private func verifyProof(_ body: [String: Any], deviceID: String, operation: String = "approve") throws -> Bool {
        guard let metadata, let signingKey = metadata["signing_public_key"] as? String,
              let signature = body["signature"] as? String, let nonce = body["nonce"] as? String,
              body["operation"] as? String == operation, body["deviceId"] as? String == deviceID,
              let spki = Data(base64Encoded: signingKey), let signatureBytes = Data(base64Encoded: signature) else { return false }
        let publicKey = try P256.Signing.PublicKey(derRepresentation: spki)
        let proofSignature = try P256.Signing.ECDSASignature(rawRepresentation: signatureBytes)
        return publicKey.isValidSignature(proofSignature, for: Data([nonce, operation, deviceID].joined(separator: "\u{001f}").utf8))
    }

    private static func sealBindNonce(publicKey: Data) throws -> ([String: String], String) {
        let recipient = try P256.KeyAgreement.PublicKey(x963Representation: publicKey)
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let ephemeralRaw = ephemeral.publicKey.x963Representation
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: recipient).withUnsafeBytes { Data($0) }
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: shared), salt: ephemeralRaw, info: Data("thunderbolt-device-bind-v1".utf8), outputByteCount: 32)
        let nonce = UUID().uuidString.lowercased()
        let iv = Data(repeating: 0x5a, count: 12)
        let sealed = try AES.GCM.seal(Data(nonce.utf8), using: key, nonce: AES.GCM.Nonce(data: iv))
        return (["ephemeral_public_key": ephemeralRaw.base64EncodedString(), "iv": iv.base64EncodedString(), "ciphertext": (sealed.ciphertext + sealed.tag).base64EncodedString()], nonce)
    }

    private static func jsonObject(_ data: Data) throws -> [String: Any] {
        guard !data.isEmpty else { return [:] }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    private static func json(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }
}

private struct DeviceFlowEnvelope: Sendable {
    let trusted: Bool
    let wrappedCK: String
    let attestation: String
}

private struct DeviceFlowRegistration: Sendable {
    let ecdhPublicKey: Data
    let mlkemPublicKey: Data
    let mlkemPublicKeyText: String
}

private struct DeviceFlowApprovalSession {
    let sessionID: String
    let commitment: String
    var reveal: String?
    var challenge: String?
    var challengerDeviceID: String?

    var json: [String: Any] {
        [
            "sessionId": sessionID,
            "commitment": commitment,
            "reveal": reveal.map { $0 as Any } ?? NSNull(),
            "challenge": challenge.map { $0 as Any } ?? NSNull(),
            "challengerDeviceId": challengerDeviceID.map { $0 as Any } ?? NSNull(),
            "expired": false,
        ]
    }
}

private enum DeviceFlowFailure: Error { case invalidBody }

private final class DeviceFlowURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static let transport = DeviceFlowTransport()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let request = try Self.readBody(request)
            let (data, status) = try Self.transport.handle(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    private static func readBody(_ request: URLRequest) throws -> URLRequest {
        guard request.httpBody == nil, let stream = request.httpBodyStream else { return request }
        stream.open()
        defer { stream.close() }
        var body = Data()
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1024)
        defer { buffer.deallocate() }
        while true {
            let count = stream.read(buffer, maxLength: 1024)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeContentData) }
            if count == 0 { break }
            body.append(buffer, count: count)
        }
        var normalized = request
        normalized.httpBodyStream = nil
        normalized.httpBody = body
        return normalized
    }
}

private extension Data {
    static func json(_ value: String) -> Data { Data(value.utf8) }
}
