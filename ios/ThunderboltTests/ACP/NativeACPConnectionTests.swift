/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class NativeACPConnectionTests: XCTestCase {
    func testInitializeNewSessionPromptCancelAndSessionUpdatesUseACPJSONRPC() async throws {
        let transport = ACPTestTransport()
        let connection = NativeACPConnection(transport: transport)
        await connection.startReceiving()
        let sessionID = try await connection.newSession()
        XCTAssertEqual(sessionID, "session-1")
        let stopReason = try await connection.prompt(sessionID: sessionID, text: "hello")
        XCTAssertEqual(stopReason, "end_turn")
        try await connection.cancel(sessionID: sessionID)

        let sent = await transport.sentMessages
        XCTAssertEqual(sent.compactMap { $0["method"]?.stringValue }, ["session/new", "session/prompt", "session/cancel"])
        XCTAssertEqual(sent[1]["params"]?["prompt"]?.arrayValue?.first?["text"]?.stringValue, "hello")
        XCTAssertNil(sent[2]["id"])

        var iterator = connection.events.makeAsyncIterator()
        let event = await iterator.next()
        XCTAssertEqual(event, .sessionUpdate(sessionID: sessionID, update: .object([
            "sessionUpdate": .string("agent_message_chunk"),
            "content": .object(["type": .string("text"), "text": .string("hi")]),
        ])))
        await connection.close()
    }

    func testUnknownIncomingPermissionIsCanceledByDefault() async throws {
        let transport = ACPTestTransport()
        let connection = NativeACPConnection(transport: transport)
        await connection.startReceiving()
        await transport.push(.object([
            "jsonrpc": .string("2.0"), "id": .number(44), "method": .string("session/request_permission"),
            "params": .object(["sessionId": .string("s-1")]),
        ]))
        let response = try await transport.nextSentMessage()
        XCTAssertEqual(response["id"], .number(44))
        XCTAssertEqual(response["result"]?["outcome"]?["outcome"], .string("cancelled"))
        await connection.close()
    }
}

private actor ACPTestTransport: NativeACPTransport {
    private let inbound: AsyncStream<ChatJSONValue>
    private let continuation: AsyncStream<ChatJSONValue>.Continuation
    private(set) var sentMessages: [ChatJSONValue] = []
    private var sentWaiters: [CheckedContinuation<ChatJSONValue, Never>] = []

    init() {
        let stream = AsyncStream<ChatJSONValue>.makeStream()
        inbound = stream.stream
        continuation = stream.continuation
    }

    func send(_ message: ChatJSONValue) async throws {
        sentMessages.append(message)
        if !sentWaiters.isEmpty { sentWaiters.removeFirst().resume(returning: message) }
        guard let id = message["id"] else { return }
        let method = message["method"]?.stringValue
        let result: ChatJSONValue = switch method {
        case "session/new": .object(["sessionId": .string("session-1")])
        case "session/prompt": .object(["stopReason": .string("end_turn")])
        default: .object([:])
        }
        continuation.yield(.object(["jsonrpc": .string("2.0"), "id": id, "result": result]))
        if method == "session/prompt" {
            continuation.yield(.object([
                "jsonrpc": .string("2.0"), "method": .string("session/update"),
                "params": .object([
                    "sessionId": .string("session-1"), "update": .object([
                        "sessionUpdate": .string("agent_message_chunk"),
                        "content": .object(["type": .string("text"), "text": .string("hi")]),
                    ]),
                ]),
            ]))
        }
    }

    func receive() async throws -> ChatJSONValue {
        for await message in inbound { return message }
        throw NativeACPError.closed
    }

    func close() async { continuation.finish() }

    func push(_ message: ChatJSONValue) { continuation.yield(message) }

    func nextSentMessage() async -> ChatJSONValue {
        if !sentMessages.isEmpty { return sentMessages.removeFirst() }
        return await withCheckedContinuation { sentWaiters.append($0) }
    }
}
