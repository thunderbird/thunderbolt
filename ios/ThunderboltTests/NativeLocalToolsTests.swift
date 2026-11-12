/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class NativeLocalToolsTests: XCTestCase {
    func testMCPDispatchIsBoundToOneLiveConversationRun() async throws {
        let tools = NativeLocalTools()
        let first = await tools.configure(threadID: "same-chat", conversations: [], mcpCall: { server, name, input in
            .object(["server": .string(server), "tool": .string(name), "input": .object(input)])
        })
        let second = await tools.configure(threadID: "same-chat", conversations: [])
        let arguments = #"{"serverID":"docs","name":"lookup","arguments":{"query":"plan"}}"#
        let value = try await tools.execute(threadID: first, name: "mcp_call_tool", argumentsJSON: arguments)
        let decoded = try JSONDecoder().decode(ChatJSONValue.self, from: Data(value.utf8))
        XCTAssertEqual(decoded["input"]?["query"], .string("plan"))
        for context in [second, "unknown"] {
            do { _ = try await tools.execute(threadID: context, name: "mcp_call_tool", argumentsJSON: arguments); XCTFail("A run without MCP tools must not execute another run's tools") }
            catch NativeLocalToolError.unavailable { }
        }
        await tools.remove(threadID: first)
        do { _ = try await tools.execute(threadID: first, name: "mcp_call_tool", argumentsJSON: arguments); XCTFail("An ended run must not retain tool access") }
        catch NativeLocalToolError.unavailable { }
    }

    func testGlobalSearchUsesCanonicalPlanAndFindsMessageContentWithoutTitleMatches() throws {
        let chat = Conversation(title: "Earlier conversation", messages: [.init(role: .user, text: "The café charged twenty dollars.")])
        let match = try NativeChatSearch.find("cafe twen", conversations: [chat])
        XCTAssertEqual(match.first?.threadID, chat.id)
        let empty = Conversation(title: "Empty project chat")
        XCTAssertEqual(try NativeChatSearch.find("project", conversations: [empty]).first?.threadID, empty.id)
        XCTAssertTrue(try NativeChatSearch.find("!!!", conversations: [chat]).isEmpty)
        let japanese = try NativeChatSearch.plan("東京の天気")
        XCTAssertNil(japanese.match)
        XCTAssertTrue(japanese.substrings.contains("東京"))
        XCTAssertTrue(japanese.substrings.contains("天気"))
    }
    func testProjectSearchUsesAccentFoldingPrefixesAndExcludesTombstones() throws {
        let live = Conversation(title: "Café discussion", messages: [ChatMessage(role: .user, text: "Pricing costs twenty dollars")])
        let removed = Conversation(title: "Deleted", deletedAt: Date(), messages: [ChatMessage(role: .user, text: "pricing secret")])
        let hits = try NativeProjectSearch.search([live, removed], query: .init(query: "cafe pric", match: "\"cafe\"* AND \"pric\"*", substrings: []))
        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(hits.first?.threadID, live.id)
        XCTAssertTrue(hits.first?.excerpt.contains("twenty") == true)
    }

    func testProjectSearchSupportsSubstringPlansAndEscapesWildcards() throws {
        let chat = Conversation(title: "計画", messages: [ChatMessage(role: .user, text: "東京の計画には50%の割引があります")])
        let hits = try NativeProjectSearch.search([chat], query: .init(query: "東京", match: nil, substrings: ["東京"]))
        XCTAssertEqual(hits.count, 1)
        let wildcard = try NativeProjectSearch.search([chat], query: .init(query: "_", match: nil, substrings: ["_"]))
        XCTAssertTrue(wildcard.isEmpty)
    }

    func testConcurrentRunsCannotReplaceOrRemoveEachOthersSearchContext() async throws {
        let tools = NativeLocalTools()
        let first = await tools.configure(threadID: "current", conversations: [Conversation(title: "First", messages: [.init(role: .user, text: "needle")])])
        let second = await tools.configure(threadID: "current", conversations: [Conversation(title: "Second", messages: [.init(role: .user, text: "needle")])])
        await tools.remove(threadID: first)
        let result = try await tools.execute(threadID: second, name: "search_project_chats", argumentsJSON: #"{"query":"needle","match":"needle*","substrings":[]}"#)
        XCTAssertTrue(result.contains("Second"))
        XCTAssertFalse(result.contains("First"))
    }
}
