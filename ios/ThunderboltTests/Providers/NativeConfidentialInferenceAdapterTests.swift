/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import XCTest
import Tinfoil
@testable import Thunderbolt

final class NativeConfidentialInferenceAdapterTests: XCTestCase {
    func testConvertsReasoningToolAndUsageChunksToOpenAISSE() async throws {
        let chunks = try [Self.reasoningChunk, Self.toolChunk, Self.usageChunk].map {
            try JSONDecoder().decode(ChatStreamResult.self, from: Data($0.utf8))
        }
        let factory = StubTinfoilChatFactory(chunks: chunks)
        let adapter = try NativeManagedTinfoilInferenceAdapter(backendURL: Self.backendURL, factory: factory)
        let recorder = InferenceEvents()

        _ = adapter.start(request: try Self.request(), onHeaders: recorder.receive(status:headers:),
                          onChunk: recorder.receive(chunk:), onComplete: recorder.finish(error:))
        await fulfillment(of: [recorder.completed], timeout: 3)

        let snapshot = recorder.snapshot
        XCTAssertEqual(snapshot.status, 200)
        XCTAssertEqual(snapshot.headers["Content-Type"], "text/event-stream; charset=utf-8")
        XCTAssertTrue(snapshot.body.contains("data: [DONE]"))
        XCTAssertTrue(snapshot.body.contains("reasoning_content"), snapshot.body)
        XCTAssertTrue(snapshot.body.contains("tool_calls"), snapshot.body)
        XCTAssertTrue(snapshot.body.contains("usage"), snapshot.body)
        XCTAssertTrue(snapshot.body.contains("prompt_tokens"), snapshot.body)
        XCTAssertNil(snapshot.error)
        let requestCount = await factory.requestCount
        XCTAssertEqual(requestCount, 1)
    }

    func testRejectsRequestsOutsideManagedRouteWithoutCallingSDK() async throws {
        let factory = StubTinfoilChatFactory(chunks: [])
        let adapter = try NativeManagedTinfoilInferenceAdapter(backendURL: Self.backendURL, factory: factory)
        let recorder = InferenceEvents()
        let original = try Self.request()
        let request = NativeConfidentialInferenceRequest(
            url: URL(string: "https://other.example/v1/tinfoil/chat/completions")!,
            method: original.method,
            headers: original.headers,
            body: original.body
        )

        _ = adapter.start(request: request, onHeaders: recorder.receive(status:headers:),
                          onChunk: recorder.receive(chunk:), onComplete: recorder.finish(error:))
        await fulfillment(of: [recorder.completed], timeout: 1)

        XCTAssertEqual(recorder.snapshot.status, 404)
        XCTAssertTrue(recorder.snapshot.body.contains("managed confidential inference"))
        let requestCount = await factory.requestCount
        XCTAssertEqual(requestCount, 0)
    }

    func testRejectsNonStreamingRequest() async throws {
        let factory = StubTinfoilChatFactory(chunks: [])
        let adapter = try NativeManagedTinfoilInferenceAdapter(backendURL: Self.backendURL, factory: factory)
        let recorder = InferenceEvents()
        let body = Data(#"{"model":"glm-5-2","messages":[{"role":"user","content":"hello"}],"stream":false}"#.utf8)
        let request = NativeConfidentialInferenceRequest(
            url: URL(string: "https://api.example.test/v1/tinfoil/chat/completions")!,
            method: "POST", headers: [:], body: body
        )

        _ = adapter.start(request: request, onHeaders: recorder.receive(status:headers:),
                          onChunk: recorder.receive(chunk:), onComplete: recorder.finish(error:))
        await fulfillment(of: [recorder.completed], timeout: 1)

        XCTAssertEqual(recorder.snapshot.status, 400)
        let requestCount = await factory.requestCount
        XCTAssertEqual(requestCount, 0)
    }

    func testSDKFailureFailsFetchAndNeverFallsBackToPlainHTTP() async throws {
        let factory = StubTinfoilChatFactory(chunks: [], failure: StubFailure.attestationUnavailable)
        let adapter = try NativeManagedTinfoilInferenceAdapter(backendURL: Self.backendURL, factory: factory)
        let recorder = InferenceEvents()

        _ = adapter.start(request: try Self.request(), onHeaders: recorder.receive(status:headers:),
                          onChunk: recorder.receive(chunk:), onComplete: recorder.finish(error:))
        await fulfillment(of: [recorder.completed], timeout: 2)

        XCTAssertEqual(recorder.snapshot.status, 502)
        XCTAssertTrue(recorder.snapshot.body.contains("confidential model service is unavailable"))
        XCTAssertNil(recorder.snapshot.error)
    }

    private static let backendURL = URL(string: "https://api.example.test/v1")!

    private static func request() throws -> NativeConfidentialInferenceRequest {
        NativeConfidentialInferenceRequest(
            url: URL(string: "https://api.example.test/v1/tinfoil/chat/completions?stream=true")!,
            method: "POST",
            headers: ["Authorization": "Bearer session-token", "Content-Type": "application/json"],
            body: Data(#"{"model":"glm-5-2","messages":[{"role":"user","content":"hello"}],"stream":true,"reasoning_effort":"high"}"#.utf8)
        )
    }

    private static let reasoningChunk = #"{"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"glm-5-2","choices":[{"index":0,"delta":{"reasoning_content":"checking"},"finish_reason":null}]}"#
    private static let toolChunk = #"{"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"glm-5-2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"bash","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#
    private static let usageChunk = #"{"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"glm-5-2","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}"#
}

private enum StubFailure: Error {
    case attestationUnavailable
}

private actor StubTinfoilChatFactory: NativeTinfoilChatClientFactory {
    private let chunks: [ChatStreamResult]
    private let failure: StubFailure?
    private(set) var requestCount = 0

    init(chunks: [ChatStreamResult], failure: StubFailure? = nil) {
        self.chunks = chunks
        self.failure = failure
    }

    func client() async throws -> any NativeTinfoilChatStreaming {
        requestCount += 1
        if let failure { throw failure }
        return StubTinfoilStreamingClient(chunks: chunks)
    }
}

private struct StubTinfoilStreamingClient: NativeTinfoilChatStreaming {
    let chunks: [ChatStreamResult]

    func stream(query: ChatQuery) -> AsyncThrowingStream<ChatStreamResult, Error> {
        AsyncThrowingStream { continuation in
            chunks.forEach { continuation.yield($0) }
            continuation.finish()
        }
    }
}

private final class InferenceEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var status: Int?
    private var headers: [String: String] = [:]
    private var chunks: [Data] = []
    private var error: String?
    let completed = XCTestExpectation(description: "inference request completed")

    var snapshot: (status: Int?, headers: [String: String], body: String, error: String?) {
        lock.lock()
        defer { lock.unlock() }
        return (status, headers, String(decoding: chunks.reduce(into: Data()) { $0.append($1) }, as: UTF8.self), error)
    }

    func receive(status: Int, headers: [String: String]) {
        lock.lock()
        self.status = status
        self.headers = headers
        lock.unlock()
    }

    func receive(chunk: Data) {
        lock.lock()
        chunks.append(chunk)
        lock.unlock()
    }

    func finish(error: String?) {
        lock.lock()
        self.error = error
        lock.unlock()
        completed.fulfill()
    }
}
