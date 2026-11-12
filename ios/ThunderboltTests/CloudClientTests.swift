/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import XCTest
@testable import Thunderbolt

@MainActor
final class CloudClientTests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testDeviceRegistrationSendsSignedSessionDeviceIdentityAndHybridKeys() async throws {
        let captured = RequestCapture()
        let client = makeClient { request in
            captured.set(request)
            return (.json(#"{"trusted":false,"pendingSince":"2026-11-11T10:00:00Z"}"#), 200, [:])
        }
        client.deviceID = "device-1"
        let response = try await client.registerDevice(
            DeviceRegistrationRequest(deviceId: "device-1", publicKey: "ecdh", mlkemPublicKey: "mlkem", name: "iPhone"),
            token: "session.signature"
        )
        XCTAssertFalse(response.trusted)
        XCTAssertNotNil(response.pendingSince)
        let request = try XCTUnwrap(captured.get())
        XCTAssertEqual(request.url?.path, "/v1/devices")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer session.signature")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Device-ID"), "device-1")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String])
        XCTAssertEqual(body["mlkemPublicKey"], "mlkem")
        XCTAssertEqual(body["publicKey"], "ecdh")
    }

    func testMissingEncryptionMetadataOnlyMeansFirstDeviceFor404() async throws {
        let missing = makeClient { _ in (.json(#"{"error":"not found"}"#), 404, [:]) }
        let metadata = try await missing.encryptionMetadata(token: "token")
        XCTAssertNil(metadata)
        for status in [401, 403, 500] {
            let client = makeClient { _ in (.json(#"{"error":"unavailable"}"#), status, [:]) }
            do {
                _ = try await client.encryptionMetadata(token: "token")
                XCTFail("Must not bootstrap on HTTP \(status)")
            } catch CloudError.http(let actual, _) { XCTAssertEqual(actual, status) }
        }
    }

    func testDeviceBindNeverUsesAccountProofInPlaceOfSealedNonce() async throws {
        let captured = RequestCapture()
        let client = makeClient { request in
            captured.set(request)
            return (.json("{}"), 200, [:])
        }
        client.deviceID = "device-1"
        try await client.bindDevice(id: "device-1", nonce: "opened-nonce", token: "token")
        let request = try XCTUnwrap(captured.get())
        XCTAssertEqual(request.url?.path, "/v1/devices/me/bind")
        let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String]
        XCTAssertEqual(body, ["deviceId": "device-1", "nonce": "opened-nonce"])
    }

    func testApprovalCancellationCarriesRegistrationScope() async throws {
        let captured = RequestCapture()
        let client = makeClient { request in
            captured.set(request)
            return (.json("{}"), 200, [:])
        }
        try await client.cancelDeviceApproval(pendingSince: "attempt-1", token: "token")
        let request = try XCTUnwrap(captured.get())
        let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String]
        XCTAssertEqual(body, ["pendingSince": "attempt-1"])
    }

    func testSendCodeUsesWaitlistJoinAndReturnsChallenge() async throws {
        let captured = RequestCapture()
        let client = makeClient { request in
            captured.set(request)
            return (.json(#"{"success":true,"challengeToken":"challenge-1"}"#), 200, [:])
        }

        let challenge = try await client.sendCode(email: "croth@thunderbolt.io")

        XCTAssertEqual(challenge, "challenge-1")
        let request = try XCTUnwrap(captured.get())
        XCTAssertEqual(request.url?.absoluteString, "http://localhost:8000/v1/waitlist/join")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Platform"), "ios")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-App-Version"), "0.1.164")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String], ["email": "croth@thunderbolt.io"])
    }

    func testVerifyCodeSendsChallengeAndStoresTheSignedBearerFromResponse() async throws {
        let captured = RequestCapture()
        let signed = "raw-session-token.signature"
        let client = makeClient { request in
            captured.set(request)
            return (
                .json(#"{"session":{"token":"raw-session-token"},"user":{"id":"u1","name":"Chris","email":"croth@thunderbolt.io"}}"#),
                200,
                ["set-auth-token": signed]
            )
        }

        let session = try await client.verifyCode(email: "croth@thunderbolt.io", code: "12345678", challenge: "challenge-1")

        XCTAssertEqual(session.token, signed)
        XCTAssertEqual(session.user.id, "u1")
        let request = try XCTUnwrap(captured.get())
        XCTAssertEqual(request.url?.path, "/v1/api/auth/sign-in/email-otp")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-challenge-token"), "challenge-1")
        let body = try XCTUnwrap(request.httpBody)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["email": "croth@thunderbolt.io", "otp": "12345678"])
    }

    func testRestoreSessionUsesBearerAndAcceptsNullSessionAsSignedOut() async throws {
        let captured = RequestCapture()
        let client = makeClient { request in
            captured.set(request)
            return (.json("null"), 200, [:])
        }

        let session = try await client.restoreSession(token: "stored.signature")

        XCTAssertNil(session)
        let request = try XCTUnwrap(captured.get())
        XCTAssertEqual(request.url?.path, "/v1/api/auth/get-session")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer stored.signature")
    }

    func testRestoreSessionRejectsMalformedSuccessfulPayloads() async {
        for body in ["not json", #"{"session":null}"#] {
            let client = makeClient { _ in (.json(body), 200, [:]) }
            do {
                _ = try await client.restoreSession(token: "stored.signature")
                XCTFail("Expected an invalid-response error for payload: \(body)")
            } catch let error as CloudError {
                XCTAssertEqual(error, .invalidResponse)
            } catch {
                XCTFail("Unexpected error: \(error)")
            }
        }
    }

    func testLoadModelsUsesPublicConfigAndAgentsAndSkipsConfidentialModels() async throws {
        let requestedPaths = PathCapture()
        let client = makeClient { request in
            requestedPaths.insert(request.url?.path ?? "")
            if request.url?.path == "/v1/config" {
                return (
                    .json(#"""
                    {"defaults":{"models":{"defaultModelId":"opus-id","data":[
                      {"id":"deepseek-id","name":"DeepSeek","model":"deepseek-v4-1-flash","provider":"tinfoil","vendor":"deepseek","enabled":1,"deletedAt":null},
                      {"id":"opus-id","name":"Opus 5.5","model":"opus-5-5","provider":"thunderbolt","vendor":"anthropic","enabled":1,"deletedAt":null}
                    ]}}}
                    """#),
                    200,
                    [:]
                )
            }
            return (
                .json(#"""
                {"version":"1","defaultAgentId":"hosted-agent","agents":[
                  {"id":"hosted-agent","name":"Cloud Agent","type":"managed-http","transport":"http","url":"/v1/agent/chat","isSystem":1},
                  {"id":"custom","name":"Custom","type":"managed-http","url":"/v1/agent/chat","isSystem":0}
                ]}
                """#),
                200,
                [:]
            )
        }

        let models = try await client.loadModels(token: "bearer")

        XCTAssertEqual(requestedPaths.get(), ["/v1/config", "/v1/agents"])
        XCTAssertEqual(models.map(\.id), ["hosted-agent", "opus-id"])
        XCTAssertEqual(models.first?.endpoint, "/v1/agent/chat")
        XCTAssertEqual(models.last?.vendor, "anthropic")
    }

    func testNonSuccessResponseBecomesCloudHTTPError() async {
        let client = makeClient { _ in
            (.json(#"{"error":"APP_VERSION_UNSUPPORTED","minAppVersion":"99.0.0"}"#), 426, [:])
        }

        do {
            _ = try await client.sendCode(email: "croth@thunderbolt.io")
            XCTFail("Expected a CloudError")
        } catch let error as CloudError {
            XCTAssertEqual(error, .http(426, "APP_VERSION_UNSUPPORTED"))
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testHostedStreamUsesUIMessageWireAndStreamsText() async throws {
        let capture = RequestCapture()
        let client = makeClient { request in
            capture.set(request)
            let events = [
                #"data: {"type":"start","messageId":"assistant-1"}"#,
                #"data: {"type":"text-start","id":"text-1"}"#,
                #"data: {"type":"text-delta","id":"text-1","delta":"Hello"}"#,
                #"data: {"type":"text-delta","id":"text-1","delta":" world"}"#,
                #"data: {"type":"finish"}"#,
                "data: [DONE]",
                "",
            ].joined(separator: "\n\n")
            return (Data(events.utf8), 200, ["Content-Type": "text/event-stream"])
        }
        let user = ChatMessage(role: .user, text: "Hi")
        let conversationID = "tauri-thread-id"
        var output = ""
        var finishCount = 0

        try await client.stream(
            messages: [user],
            conversationID: conversationID,
            model: ChatModel(id: "hosted-agent", name: "Cloud Agent", model: "hosted-agent", vendor: nil, endpoint: "/v1/agent/chat"),
            token: "signed-token",
            onEvent: { event in
                switch event {
                case .text(let text):
                    output += text
                case .content(let parts, _): output = parts.filter(\.isText).compactMap(\.text).joined()
                case .finished: finishCount += 1
                case .status: break
                }
            }
        )

        let request = try XCTUnwrap(capture.get())
        XCTAssertEqual(request.url?.path, "/v1/agent/chat")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer signed-token")
        let bodyData = try XCTUnwrap(request.httpBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
        XCTAssertEqual(body["id"] as? String, conversationID)
        let messages = try XCTUnwrap(body["messages"] as? [[String: Any]])
        XCTAssertEqual(messages.first?["role"] as? String, "user")
        let parts = try XCTUnwrap(messages.first?["parts"] as? [[String: Any]])
        XCTAssertEqual(parts.first?["text"] as? String, "Hi")
        XCTAssertEqual(output, "Hello world")
        XCTAssertEqual(finishCount, 1)
    }

    func testStreamEventEmitterFlushesCoalescedTextBeforeFinish() {
        var textEvents: [String] = []
        var didFinish = false
        let emitter = StreamEventEmitter { event in
            switch event {
            case .text(let text): textEvents.append(text)
            case .finished: didFinish = true
            case .status, .content: break
            }
        }

        emitter.emit(.text("Hello"))
        emitter.emit(.text(" world"))
        XCTAssertTrue(textEvents.isEmpty)

        emitter.emit(.finished)

        XCTAssertEqual(textEvents, ["Hello world"])
        XCTAssertTrue(didFinish)
    }

    func testHostedStreamSurfacesServerErrorsAndRejectsTruncatedStreams() async throws {
        let errorClient = makeClient { _ in
            let body = #"data: {"type":"error","errorText":"Server-side agent error"}"# + "\n\n"
            return (Data(body.utf8), 200, ["Content-Type": "text/event-stream"])
        }
        let model = ChatModel(id: "hosted-agent", name: "Cloud Agent", model: "hosted-agent", vendor: nil, endpoint: "/v1/agent/chat")

        do {
            try await errorClient.stream(
                messages: [ChatMessage(role: .user, text: "Hi")],
                conversationID: UUID().uuidString,
                model: model,
                token: "signed-token",
                onEvent: { _ in }
            )
            XCTFail("Expected streamed error")
        } catch let error as CloudError {
            XCTAssertEqual(error, .http(500, "Server-side agent error"))
        }

        let truncatedClient = makeClient { _ in
            let body = #"data: {"type":"text-start","id":"text-1"}"# + "\n\n" +
                #"data: {"type":"text-delta","id":"text-1","delta":"partial"}"# + "\n\n"
            return (Data(body.utf8), 200, ["Content-Type": "text/event-stream"])
        }
        var partialOutput = ""
        do {
            try await truncatedClient.stream(
                messages: [ChatMessage(role: .user, text: "Hi")],
                conversationID: UUID().uuidString,
                model: model,
                token: "signed-token",
                onEvent: { event in
                    if case .text(let text) = event { partialOutput += text }
                    if case .content(let parts, _) = event { partialOutput = parts.filter(\.isText).compactMap(\.text).joined() }
                }
            )
            XCTFail("Expected an interrupted-stream error")
        } catch let error as CloudError {
            XCTAssertEqual(error, .interrupted)
        }
        XCTAssertEqual(partialOutput, "partial")
    }

    private func makeClient(
        handler: @escaping (URLRequest) throws -> (Data, Int, [String: String])
    ) -> CloudClient {
        StubURLProtocol.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration)
        return CloudClient(baseURL: URL(string: "http://localhost:8000/v1")!, session: session)
    }
}

private extension Data {
    static func json(_ value: String) -> Data { Data(value.utf8) }
}

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Data, Int, [String: String]))?
    nonisolated(unsafe) private static var originalRequest: URLRequest?

    static func reset() {
        handler = nil
        originalRequest = nil
    }

    override class func canInit(with request: URLRequest) -> Bool {
        originalRequest = request
        return true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let request = Self.originalRequest ?? request
            let (data, status, headers) = try handler(Self.requestWithBodyData(request))
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    private static func requestWithBodyData(_ request: URLRequest) throws -> URLRequest {
        guard request.httpBody == nil, let stream = request.httpBodyStream else { return request }
        stream.open()
        defer { stream.close() }

        var body = Data()
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1_024)
        defer { buffer.deallocate() }
        while true {
            let count = stream.read(buffer, maxLength: 1_024)
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

private final class RequestCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var request: URLRequest?

    func set(_ request: URLRequest) {
        lock.lock()
        self.request = request
        lock.unlock()
    }

    func get() -> URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return request
    }
}

private final class PathCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var paths: Set<String> = []

    func insert(_ path: String) {
        lock.lock()
        paths.insert(path)
        lock.unlock()
    }

    func get() -> Set<String> {
        lock.lock()
        defer { lock.unlock() }
        return paths
    }
}
