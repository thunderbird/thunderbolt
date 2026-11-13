/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import SQLite3

protocol NativeLocalToolHandling: Sendable {
    func execute(threadID: String, name: String, argumentsJSON: String) async throws -> String
}

typealias NativeMCPToolCall = @Sendable (String, String, [String: ChatJSONValue]) async throws -> ChatJSONValue

actor NativeLocalTools: NativeLocalToolHandling {
    private var projects: [String: [Conversation]] = [:]
    private var mcpCalls: [String: NativeMCPToolCall] = [:]

    func configure(threadID: String, conversations: [Conversation], mcpCall: NativeMCPToolCall? = nil) -> String {
        let contextID = UUID().uuidString
        projects[contextID] = conversations.filter { $0.id != threadID && $0.deletedAt == nil }
        mcpCalls[contextID] = mcpCall
        return contextID
    }

    func remove(threadID: String) { projects[threadID] = nil; mcpCalls[threadID] = nil }
    func clear() { projects = [:]; mcpCalls = [:] }

    func execute(threadID: String, name: String, argumentsJSON: String) async throws -> String {
        let result: ChatJSONValue
        switch name {
        case "mcp_call_tool":
            let arguments = try JSONDecoder().decode(ChatJSONValue.self, from: Data(argumentsJSON.utf8))
            guard let call = mcpCalls[threadID], let serverID = arguments["serverID"]?.stringValue,
                  let name = arguments["name"]?.stringValue,
                  let input = arguments["arguments"]?.objectValue else { throw NativeLocalToolError.unavailable }
            result = try await call(serverID, name, input)
        case "search_project_chats":
            let query = try JSONDecoder().decode(NativeProjectSearch.Query.self, from: Data(argumentsJSON.utf8))
            let hits = try NativeProjectSearch.search(projects[threadID] ?? [], query: query)
            let text = hits.isEmpty
                ? "No messages in this project's other chats matched \"\(query.query)\". This is a keyword search, so try different wording or related terms before telling the user it wasn't discussed."
                : hits.map { "From \"\($0.title)\":\n\($0.excerpt)" }.joined(separator: "\n\n")
            result = .string(text)
        case "render_html":
            let arguments = try JSONDecoder().decode(ChatJSONValue.self, from: Data(argumentsJSON.utf8))
            guard let html = arguments["html"]?.stringValue else { throw CloudError.invalidResponse }
            result = try await NativeArtifactVerifier.verify(html)
        default:
            throw NativeLocalToolError.unavailable
        }
        return String(decoding: try JSONEncoder().encode(result), as: UTF8.self)
    }
}

enum NativeLocalToolError: LocalizedError {
    case unavailable, searchFailed(String)
    var errorDescription: String? {
        switch self {
        case .unavailable: nativeString( "This tool is not available in this chat.")
        case .searchFailed(let message): message
        }
    }
}

enum NativeProjectSearch {
    struct Query: Decodable, Sendable {
        let query: String
        let match: String?
        let substrings: [String]
    }
    struct Hit: Equatable, Sendable { let threadID: String; let title: String; let excerpt: String }

    /// Uses Tauri's FTS5 tokenizer, weights, and excerpt policy. The index exists
    /// only for the tool call; the source rows remain encrypted in PowerSync.
    static func search(_ conversations: [Conversation], query: Query, includeTitles: Bool = false, limit: Int = 8) throws -> [Hit] {
        guard query.match != nil || !query.substrings.isEmpty, !conversations.isEmpty else { return [] }
        var connection: OpaquePointer?
        guard sqlite3_open(":memory:", &connection) == SQLITE_OK, let connection else {
            if let connection { sqlite3_close(connection) }
            throw NativeLocalToolError.searchFailed("Could not create the local search index.")
        }
        defer { sqlite3_close(connection) }
        try execute(connection, sql: "CREATE VIRTUAL TABLE search_index USING fts5(id UNINDEXED, entity_type UNINDEXED, parent_id UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2')")
        for chat in conversations where chat.deletedAt == nil {
            try Task.checkCancellation()
            if includeTitles {
                try execute(connection, sql: "INSERT INTO search_index(id, entity_type, parent_id, title, body) VALUES (?, 'thread', ?, ?, '')",
                    values: [chat.id, chat.id, chat.title])
            }
            for message in chat.messages where message.deletedAt == nil && !message.text.isEmpty {
                try execute(connection, sql: "INSERT INTO search_index(id, entity_type, parent_id, title, body) VALUES (?, 'message', ?, ?, ?)",
                    values: [message.id, chat.id, chat.title, message.text])
            }
        }
        var parameters: [String] = []
        let excerpt: String
        if query.match != nil { excerpt = "snippet(search_index, 4, '', '', '…', 30)" }
        else {
            excerpt = "substr(body, max(1, instr(body, ?) - 24), 160)"
            parameters.append(query.substrings[0])
        }
        var filters: [String] = []
        if let match = query.match { filters.append("search_index MATCH ?"); parameters.append(match) }
        for term in query.substrings {
            filters.append("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')")
            let escaped = term.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "%", with: "\\%").replacingOccurrences(of: "_", with: "\\_")
            parameters += ["%" + escaped + "%", "%" + escaped + "%"]
        }
        let order = query.match == nil ? "id DESC" : "bm25(search_index, 1.0, 1.0, 1.0, 10.0, 1.0)"
        let statement = try prepare(connection, sql: "SELECT parent_id, title, \(excerpt) FROM search_index WHERE \(filters.joined(separator: " AND ")) ORDER BY \(order) LIMIT \(min(50, max(1, limit)))", values: parameters)
        defer { sqlite3_finalize(statement) }
        var hits: [Hit] = []
        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { return hits }
            guard status == SQLITE_ROW else { throw failure(connection) }
            hits.append(Hit(threadID: column(statement, 0), title: column(statement, 1), excerpt: column(statement, 2)))
        }
    }

    private static func column(_ statement: OpaquePointer, _ index: Int32) -> String {
        sqlite3_column_text(statement, index).map { String(cString: $0) } ?? ""
    }

    private static func execute(_ connection: OpaquePointer, sql: String, values: [String] = []) throws {
        let statement = try prepare(connection, sql: sql, values: values)
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw failure(connection) }
    }

    private static func prepare(_ connection: OpaquePointer, sql: String, values: [String]) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(connection, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw failure(connection) }
        for (index, value) in values.enumerated() {
            let status = value.withCString { sqlite3_bind_text(statement, Int32(index + 1), $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
            guard status == SQLITE_OK else { sqlite3_finalize(statement); throw failure(connection) }
        }
        return statement
    }

    private static func failure(_ connection: OpaquePointer) -> NativeLocalToolError {
        .searchFailed(String(cString: sqlite3_errmsg(connection)))
    }
}
