/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Network
import XCTest
@testable import Thunderbolt

@MainActor
final class PiAgentRuntimeTests: XCTestCase {
    func testLoopbackStreamingAndWorkspaceRestoreAcrossHarnesses() async throws {
        let requests = CapturedRequests()
        let server = try LoopbackSSEServer { index, body in
            requests.append(body)
            switch index {
            case 0:
                return Self.toolCall(command: "printf 'persistent marker' > durable.txt")
            case 1:
                return Self.text("Saved the file.")
            case 2:
                return Self.toolCall(command: "cat durable.txt")
            default:
                return Self.text("The file contains persistent marker.")
            }
        }
        defer { server.stop() }

        let threadID = UUID().uuidString.lowercased()
        let userID = "runtime-test-\(UUID().uuidString.lowercased())"
        let options = try Self.optionsJSON(baseURL: server.url.appending(path: "v1").absoluteString, threadID: threadID)
        let runtime = try PiAgentRuntime(serverURL: Self.backendURL(for: server.url), userID: userID)
        let firstHarness = try await createHarness(runtime, optionsJSON: options)
        let firstReply = try await run(runtime, harnessID: firstHarness, prompt: "Create durable.txt with the marker.")
        XCTAssertTrue(firstReply.contains("Saved the file."), firstReply)
        runtime.dispose(harnessID: firstHarness)

        let persistedWorkspace = NativeAgentWorkspaceStore(serverURL: Self.backendURL(for: server.url), userID: userID).load(threadID: threadID)
        let encodedMarker = Data("persistent marker".utf8).base64EncodedString()
        XCTAssertTrue(persistedWorkspace?.contains(encodedMarker) == true, "The native workspace snapshot should contain the written file before the harness is recreated.")

        let restoredRuntime = try PiAgentRuntime(serverURL: Self.backendURL(for: server.url), userID: userID)
        let restoredHarness = try await createHarness(restoredRuntime, optionsJSON: options)
        let secondReply = try await run(restoredRuntime, harnessID: restoredHarness, prompt: "Read durable.txt and tell me what it contains.")
        XCTAssertTrue(secondReply.contains("The file contains persistent marker."), secondReply)
        XCTAssertEqual(requests.all.count, 4)
        XCTAssertTrue(requests.all.last?.contains("persistent marker") == true,
            "The second turn should include restored tool output in model context. Last request: \(requests.all.last ?? "<none>")")
        restoredRuntime.dispose(harnessID: restoredHarness)
    }

    func testAttachmentTextAndImageBytesReachBuiltInAgentPrompt() async throws {
        let runtime = try PiAgentRuntime(serverURL: URL(string: "http://localhost")!, userID: "attachment-runtime-\(UUID())")
        let textBytes = Data("Local markdown context.".utf8)
        let textJSON = try await runtime.prepareConversation(
            messagesJSON: Self.attachmentMessagesJSON(id: "markdown-id", filename: "notes.md", mimeType: "text/plain"),
            attachmentsJSON: Self.attachmentBytesJSON(id: "markdown-id", filename: "notes.md", mimeType: "text/plain", bytes: textBytes),
            workspaceEnabled: false,
            skillInstructionsJSON: "null"
        )
        let textResult = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(textJSON.utf8)) as? [String: Any])
        let textPrompt = try XCTUnwrap(textResult["prompt"] as? [String: Any])
        XCTAssertTrue((textPrompt["text"] as? String)?.contains("[Attachment: notes.md]\n\nLocal markdown context.") == true)
        XCTAssertEqual((textResult["files"] as? [[String: Any]])?.count, 0)

        let imageBytes = Data([0x01, 0x02, 0x03, 0x04])
        let imageJSON = try await runtime.prepareConversation(
            messagesJSON: Self.attachmentMessagesJSON(id: "image-id", filename: "diagram.png", mimeType: "image/png"),
            attachmentsJSON: Self.attachmentBytesJSON(id: "image-id", filename: "diagram.png", mimeType: "image/png", bytes: imageBytes),
            workspaceEnabled: false,
            skillInstructionsJSON: "null"
        )
        let imageResult = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(imageJSON.utf8)) as? [String: Any])
        let imagePrompt = try XCTUnwrap(imageResult["prompt"] as? [String: Any])
        let images = try XCTUnwrap(imagePrompt["images"] as? [[String: Any]])
        XCTAssertEqual(images.first?["mimeType"] as? String, "image/png")
        XCTAssertEqual(images.first?["data"] as? String, imageBytes.base64EncodedString())
        try await runtime.shutdown()
    }

    func testConnectionFailureBeforeResponseHeadersDoesNotHang() async throws {
        let server = try LoopbackSSEServer { _, _ in nil }
        let url = server.url
        server.stop()
        try await Task.sleep(for: .milliseconds(100))

        let runtime = try PiAgentRuntime(serverURL: Self.backendURL(for: url), userID: "runtime-network-failure-\(UUID())")
        let harnessID = try await createHarness(
            runtime,
            optionsJSON: Self.optionsJSON(baseURL: url.appending(path: "v1").absoluteString, threadID: UUID().uuidString.lowercased())
        )
        let output = try await run(runtime, harnessID: harnessID, prompt: "This request should fail promptly.")
        XCTAssertTrue(output.contains("error"), output)
        runtime.dispose(harnessID: harnessID)
    }

    func testStopCancelsAnInFlightLoopbackRequest() async throws {
        let server = try LoopbackSSEServer { _, _ in nil }
        defer { server.stop() }
        let runtime = try PiAgentRuntime(serverURL: Self.backendURL(for: server.url), userID: "runtime-cancel-\(UUID())")
        let harnessID = try await createHarness(
            runtime,
            optionsJSON: Self.optionsJSON(baseURL: server.url.appending(path: "v1").absoluteString, threadID: UUID().uuidString.lowercased())
        )
        let runTask = Task { try await run(runtime, harnessID: harnessID, prompt: "Wait for the server.") }
        let deadline = Date().addingTimeInterval(5)
        while server.requestCount == 0 && Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertGreaterThan(server.requestCount, 0, "The request should reach the loopback server before cancellation.")
        runtime.stop(harnessID: harnessID)
        let stoppedOutput = try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask { try await runTask.value }
            group.addTask {
                try await Task.sleep(for: .seconds(2))
                throw PiRuntimeFailure(message: "Stopping the request did not finish the UI stream")
            }
            let output = try await group.next()!
            group.cancelAll()
            return output
        }
        XCTAssertTrue(stoppedOutput.contains("\"type\":\"finish\""), "Stop should close the UI-message stream cleanly.")
        XCTAssertFalse(stoppedOutput.contains("text-delta"), "Stopping before model output must not append assistant text.")
        XCTAssertFalse(stoppedOutput.contains("tool-input"), "Stopping before model output must not start a tool call.")
        XCTAssertFalse(stoppedOutput.contains("\"type\":\"error\""), "A user stop is a clean stream close, not a provider error.")
        let requestCountAtStop = server.requestCount
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(server.requestCount, requestCountAtStop, "A stopped turn must not retry or start another provider request.")
        try await runtime.shutdown()
    }

    func testManagedTinfoilWithoutNativeAdapterDoesNotUseURLSession() async throws {
        let server = try LoopbackSSEServer { _, _ in Self.text("must not be reached") }
        defer { server.stop() }
        let runtime = try PiAgentRuntime(serverURL: Self.backendURL(for: server.url), userID: "runtime-managed-deny-\(UUID())")
        let options = try Self.optionsJSON(
            baseURL: server.url.appending(path: "v1/tinfoil").absoluteString,
            threadID: UUID().uuidString.lowercased(),
            modelKind: "confidential",
            registerTransport: false
        )
        let harnessID = try await createHarness(runtime, optionsJSON: options)
        let output = try await run(runtime, harnessID: harnessID, prompt: "Make a managed request.")

        XCTAssertEqual(server.requestCount, 0, "Managed inference must stay behind the native adapter.")
        XCTAssertTrue(output.contains("error") || output.contains("unavailable"), output)
        runtime.dispose(harnessID: harnessID)
    }

    func testUnknownTransportMarkerIsRejectedBeforeNetwork() async throws {
        let server = try LoopbackSSEServer { _, _ in Self.text("must not be reached") }
        defer { server.stop() }
        let runtime = try PiAgentRuntime(serverURL: Self.backendURL(for: server.url), userID: "runtime-unknown-transport-\(UUID())")
        let options = try Self.optionsJSON(
            baseURL: server.url.appending(path: "v1").absoluteString,
            threadID: UUID().uuidString.lowercased(),
            registerTransport: false,
            requestHeaders: [NativePiModelDescriptor.transportRegistrationHeader: "not-registered"]
        )
        let harnessID = try await createHarness(runtime, optionsJSON: options)
        let output = try await run(runtime, harnessID: harnessID, prompt: "This must be rejected.")

        XCTAssertEqual(server.requestCount, 0, "A marker header alone must not grant transport access.")
        XCTAssertTrue(output.contains("error") || output.contains("not allowed"), output)
        runtime.dispose(harnessID: harnessID)
    }

    func testReasoningResolverUsesPiCatalogAndSharedProfilePreferenceRules() async throws {
        let runtime = try PiAgentRuntime(serverURL: URL(string: "https://api.thunderbolt.example")!, userID: "reasoning-runtime-\(UUID())")
        let supportsOpenAI = try await runtime.supportsCompaction(modelJSON: #"{"provider":"openai","toolUsage":1,"model":"o3","vendor":null,"apiKey":"test-key","url":null}"#)
        let supportsGoogle = try await runtime.supportsCompaction(modelJSON: #"{"provider":"google","toolUsage":1,"model":"gemini","vendor":null,"apiKey":"test-key","url":null}"#)
        XCTAssertTrue(supportsOpenAI)
        XCTAssertFalse(supportsGoogle)
        let catalogJSON = try await runtime.resolveReasoning(
            provider: "openai",
            modelID: "o3",
            savedEffort: nil,
            profileOptionsJSON: nil
        )
        let catalog = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(catalogJSON.utf8)) as? [String: Any])
        let capabilities = try XCTUnwrap(catalog["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["efforts"] as? [String], ["low", "medium", "high"])
        XCTAssertEqual(catalog["preferredEffort"] as? String, "medium")

        let profileJSON = try await runtime.resolveReasoning(
            provider: "openai",
            modelID: "o3",
            savedEffort: nil,
            profileOptionsJSON: #"{"reasoningEffort":"high"}"#
        )
        let profile = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(profileJSON.utf8)) as? [String: Any])
        XCTAssertEqual(profile["profileEffort"] as? String, "high")
        XCTAssertEqual(profile["preferredEffort"] as? String, "high")
        XCTAssertEqual(profile["thinkingLevel"] as? String, "high")

        let remoteCapabilities = #"{"kind":"toggle","efforts":["none","high"]}"#
        let toggleJSON = try await runtime.resolveReasoning(
            provider: "openrouter",
            modelID: "router-model",
            savedEffort: nil,
            profileOptionsJSON: nil,
            capabilitiesJSON: remoteCapabilities
        )
        let toggle = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(toggleJSON.utf8)) as? [String: Any])
        XCTAssertEqual(toggle["preferredEffort"] as? String, "none")
        try await runtime.shutdown()
    }

    func testProfileDefaultAndExplicitReasoningEffortReachProviderPayload() async throws {
        let requests = CapturedRequests()
        let server = try LoopbackSSEServer { _, body in
            requests.append(body)
            return Self.text("Reasoning payload received.")
        }
        defer { server.stop() }
        let runtime = try PiAgentRuntime(serverURL: Self.backendURL(for: server.url), userID: "reasoning-payload-\(UUID())")

        let profileOptions = #"{"reasoningEffort":"low"}"#
        let profileHarness = try await createHarness(runtime, optionsJSON: Self.optionsJSON(
            baseURL: server.url.appending(path: "v1").absoluteString,
            threadID: UUID().uuidString.lowercased(),
            thinkingLevel: "high",
            profileOptionsJSON: profileOptions
        ))
        _ = try await run(runtime, harnessID: profileHarness, prompt: "Use the profile reasoning default.")
        runtime.dispose(harnessID: profileHarness)

        let overrideHarness = try await createHarness(runtime, optionsJSON: Self.optionsJSON(
            baseURL: server.url.appending(path: "v1").absoluteString,
            threadID: UUID().uuidString.lowercased(),
            thinkingLevel: "low",
            reasoningEffort: "high",
            profileOptionsJSON: profileOptions
        ))
        _ = try await run(runtime, harnessID: overrideHarness, prompt: "Use the saved explicit reasoning choice.")
        runtime.dispose(harnessID: overrideHarness)

        XCTAssertEqual(requests.all.count, 2)
        XCTAssertTrue(requests.all[0].contains(#""reasoning_effort":"low""#), requests.all[0])
        XCTAssertTrue(requests.all[1].contains(#""reasoning_effort":"high""#), requests.all[1])
        try await runtime.shutdown()
    }

    func testManualCompactionRegistersTrustedProviderTransport() async throws {
        let requests = CapturedRequests()
        let server = try LoopbackSSEServer { _, body in
            requests.append(body)
            return Self.text("A durable summary of the conversation.")
        }
        defer { server.stop() }
        let runtime = try PiAgentRuntime(serverURL: Self.backendURL(for: server.url), userID: "runtime-compact-transport-\(UUID())")
        let options = try Self.optionsJSON(
            baseURL: server.url.appending(path: "v1").absoluteString,
            threadID: UUID().uuidString.lowercased(),
            contextWindow: 8_192
        )

        let checkpointJSON = try await runtime.compactConversation(
            optionsJSON: options,
            messagesJSON: Self.compactionMessagesJSON(turns: 8, charactersPerMessage: 2_500),
            attachmentsJSON: "[]",
            workspaceEnabled: false,
            instructions: nil
        )
        let checkpoint = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(checkpointJSON.utf8)) as? [String: Any])

        XCTAssertGreaterThan(requests.all.count, 0, "Manual compaction should reach the registered native loopback transport.")
        XCTAssertTrue(requests.all.first?.contains("conversation") == true)
        XCTAssertEqual(checkpoint["version"] as? Int, 1)
        XCTAssertGreaterThan(checkpoint["contextTokens"] as? Int ?? 0, 0)
        try await runtime.shutdown()
    }

    func testManualCompactionCancellationAbortsProviderRequest() async throws {
        let server = try LoopbackSSEServer { _, _ in nil }
        defer { server.stop() }
        let runtime = try PiAgentRuntime(serverURL: Self.backendURL(for: server.url), userID: "runtime-compact-cancel-\(UUID())")
        let options = try Self.optionsJSON(
            baseURL: server.url.appending(path: "v1").absoluteString,
            threadID: UUID().uuidString.lowercased(),
            contextWindow: 8_192
        )
        let task = Task {
            try await runtime.compactConversation(
                optionsJSON: options,
                messagesJSON: Self.compactionMessagesJSON(turns: 8, charactersPerMessage: 2_500),
                attachmentsJSON: "[]",
                workspaceEnabled: false,
                instructions: nil
            )
        }
        let deadline = Date().addingTimeInterval(5)
        while server.requestCount == 0 && Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertGreaterThan(server.requestCount, 0, "Compaction should start its model request before cancellation.")
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("Cancelled compaction should throw CancellationError")
        } catch is CancellationError {
            // Expected: cancellation is propagated only after the JS harness and fetch unwind.
        }
        XCTAssertEqual(server.requestCount, 1, "A cancelled compaction must not retry or start another request.")
        try await runtime.shutdown()
    }

    private func createHarness(_ runtime: PiAgentRuntime, optionsJSON: String) async throws -> String {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            runtime.createHarness(optionsJSON: optionsJSON) { result in
                switch result {
                case .success(let harnessID): continuation.resume(returning: harnessID)
                case .failure(let failure): continuation.resume(throwing: failure)
                }
            }
        }
    }

    private func run(_ runtime: PiAgentRuntime, harnessID: String, prompt: String) async throws -> String {
        let output = LockedText()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            runtime.run(harnessID: harnessID, prompt: prompt, onChunk: { chunk in
                output.append(chunk)
            }, onComplete: { failure in
                if let failure { continuation.resume(throwing: failure) }
                else { continuation.resume(returning: ()) }
            })
        }
        return output.value
    }

    nonisolated private static func optionsJSON(
        baseURL: String,
        threadID: String,
        modelKind: String = "openai-compat",
        registerTransport: Bool = true,
        requestHeaders: [String: String]? = nil,
        thinkingLevel: String = "high",
        reasoningEffort: String? = nil,
        profileOptionsJSON: String? = nil,
        contextWindow: Int = 131_072
    ) throws -> String {
        let registrationID = UUID().uuidString.lowercased()
        let headers = requestHeaders ?? (registerTransport ? [NativePiModelDescriptor.transportRegistrationHeader: registrationID] : [:])
        let registration: Any = registerTransport ? ["id": registrationID, "kind": "direct", "baseURL": baseURL] : NSNull()
        let options: [String: Any] = [
            "model": [
                "kind": modelKind, "providerId": modelKind == "confidential" ? "thunderbolt" : "openai", "modelId": "glm-5-2",
                "vendor": "zhipu", "baseURL": baseURL, "apiKey": modelKind == "confidential" ? "thunderbolt-managed" : "test-key",
                "reasoning": true, "contextWindow": contextWindow, "supportsImages": false,
            ],
            "requestHeaders": modelKind == "confidential" ? ["Authorization": "Bearer native-test-token"] : headers,
            "transportRegistration": registration,
            "systemPrompt": "Use the bash tool when file access is requested. Answer briefly.",
            "thinkingLevel": thinkingLevel,
            "reasoningEffort": reasoningEffort.map { $0 as Any } ?? NSNull(),
            "providerOptions": try profileOptionsJSON.map { try JSONSerialization.jsonObject(with: Data($0.utf8)) } ?? NSNull(),
            "threadId": threadID,
        ]
        let data = try JSONSerialization.data(withJSONObject: options, options: [.sortedKeys])
        return try XCTUnwrap(String(data: data, encoding: .utf8))
    }

    nonisolated private static func backendURL(for loopbackURL: URL) -> URL {
        var components = URLComponents(url: loopbackURL, resolvingAgainstBaseURL: false)!
        components.host = "localhost"
        return components.url!
    }

    nonisolated private static func attachmentMessagesJSON(id: String, filename: String, mimeType: String) throws -> String {
        let value: [[String: Any]] = [[
            "id": "user-\(id)", "role": "user", "metadata": [:], "cache": [:],
            "parts": [["type": "data-attachment", "data": [
                "localFileId": id, "filename": filename, "mimeType": mimeType,
            ]]],
        ]]
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        return try XCTUnwrap(String(data: data, encoding: .utf8))
    }

    nonisolated private static func attachmentBytesJSON(id: String, filename: String, mimeType: String, bytes: Data) throws -> String {
        let value: [[String: Any]] = [[
            "localFileId": id, "filename": filename, "mimeType": mimeType,
            "base64": bytes.base64EncodedString(),
        ]]
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        return try XCTUnwrap(String(data: data, encoding: .utf8))
    }

    nonisolated private static func compactionMessagesJSON(turns: Int, charactersPerMessage: Int) -> String {
        let text = String(repeating: "Remember this project detail. ", count: charactersPerMessage / 29)
        let messages: [[String: Any]] = (0..<turns).flatMap { index in
            [
                ["id": "user-\(index)", "role": "user", "metadata": [:], "parts": [["type": "text", "text": "Question \(index): \(text)"]]],
                ["id": "assistant-\(index)", "role": "assistant", "metadata": [:], "parts": [["type": "text", "text": "Answer \(index): \(text)"]]],
            ]
        }
        let data = try! JSONSerialization.data(withJSONObject: messages, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    nonisolated private static func toolCall(command: String) -> Data {
        let arguments = try! JSONSerialization.data(withJSONObject: ["command": command], options: [.sortedKeys])
        let argumentsText = String(decoding: arguments, as: UTF8.self)
        let event: [String: Any] = [
            "id": "chatcmpl-runtime-test", "object": "chat.completion.chunk", "created": 1, "model": "glm-5-2",
            "choices": [["index": 0, "delta": ["role": "assistant", "tool_calls": [[
                "index": 0, "id": "call-runtime-test", "type": "function",
                "function": ["name": "bash", "arguments": argumentsText],
            ]]], "finish_reason": "tool_calls"]],
        ]
        return sse([event])
    }

    nonisolated private static func text(_ value: String) -> Data {
        let events: [[String: Any]] = [
            ["id": "chatcmpl-runtime-test", "object": "chat.completion.chunk", "created": 1, "model": "glm-5-2",
             "choices": [["index": 0, "delta": ["role": "assistant", "content": value], "finish_reason": NSNull()]]],
            ["id": "chatcmpl-runtime-test", "object": "chat.completion.chunk", "created": 1, "model": "glm-5-2",
             "choices": [["index": 0, "delta": [:], "finish_reason": "stop"]]],
        ]
        return sse(events)
    }

    nonisolated private static func sse(_ events: [[String: Any]]) -> Data {
        let frames = events.map { event -> String in
            do {
                let data = try JSONSerialization.data(withJSONObject: event, options: [.fragmentsAllowed, .sortedKeys])
                guard let json = String(data: data, encoding: .utf8) else {
                    XCTFail("The SSE fixture was not UTF-8 encodable")
                    return "data: {}"
                }
                return "data: \(json)"
            } catch {
                XCTFail("Could not encode an SSE fixture: \(error)")
                return "data: {}"
            }
        }
        return Data((frames + ["data: [DONE]", ""]).joined(separator: "\n\n").utf8)
    }
}

private final class LockedText: @unchecked Sendable {
    private let lock = NSLock()
    private var text = ""

    var value: String {
        lock.lock()
        defer { lock.unlock() }
        return text
    }

    func append(_ value: String) {
        lock.lock()
        text += value
        lock.unlock()
    }
}

private final class CapturedRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []

    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }

    func append(_ value: String) {
        lock.lock()
        values.append(value)
        lock.unlock()
    }
}

private final class LoopbackSSEServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "net.thunderbolt.tests.pi-runtime-loopback")
    private let lock = NSLock()
    private let handler: @Sendable (Int, String) -> Data?
    private var receivedCount = 0
    private var connections: [NWConnection] = []

    var requestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return receivedCount
    }

    var url: URL {
        URL(string: "http://127.0.0.1:\(listener.port!.rawValue)")!
    }

    init(handler: @escaping @Sendable (Int, String) -> Data?) throws {
        self.handler = handler
        listener = try NWListener(using: .tcp, on: .any)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready, .failed: ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            self.lock.lock()
            self.connections.append(connection)
            self.lock.unlock()
            connection.start(queue: self.queue)
            self.receive(connection, accumulated: Data())
        }
        listener.start(queue: queue)
        ready.wait()
        if case .failed(let error) = listener.state { throw error }
    }

    func stop() {
        listener.cancel()
        lock.lock()
        let activeConnections = connections
        connections.removeAll()
        lock.unlock()
        activeConnections.forEach { $0.cancel() }
    }

    private func receive(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            guard let self, error == nil else { connection.cancel(); return }
            let combined = accumulated + (data ?? Data())
            if let request = Self.completeRequest(from: combined) {
                self.respond(connection, request: request)
            } else if complete {
                connection.cancel()
            } else {
                self.receive(connection, accumulated: combined)
            }
        }
    }

    private func respond(_ connection: NWConnection, request: String) {
        let index: Int
        lock.lock()
        index = receivedCount
        receivedCount += 1
        lock.unlock()
        guard let body = handler(index, request) else { return }
        let headers = Data("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: \(body.count)\r\n\r\n".utf8)
        connection.send(content: headers, completion: .contentProcessed { [weak self] error in
            guard let self, error == nil else { connection.cancel(); return }
            self.send(body, offset: 0, over: connection)
        })
    }

    private func send(_ body: Data, offset: Int, over connection: NWConnection) {
        guard offset < body.count else { connection.send(content: nil, isComplete: true, completion: .contentProcessed { _ in connection.cancel() }); return }
        let end = min(offset + 128, body.count)
        let piece = body.subdata(in: offset..<end)
        connection.send(content: piece, completion: .contentProcessed { [weak self] error in
            guard let self, error == nil else { connection.cancel(); return }
            self.send(body, offset: end, over: connection)
        })
    }

    private static func completeRequest(from data: Data) -> String? {
        let delimiter = Data("\r\n\r\n".utf8)
        guard let headerRange = data.range(of: delimiter),
              let headers = String(data: data[..<headerRange.lowerBound], encoding: .utf8) else { return nil }
        let contentLength = headers.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("content-length:") }
            .flatMap { Int($0.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces) ?? "") } ?? 0
        let bodyStart = headerRange.upperBound
        guard data.count >= bodyStart + contentLength,
              let body = String(data: data[bodyStart..<(bodyStart + contentLength)], encoding: .utf8) else { return nil }
        return body
    }
}
