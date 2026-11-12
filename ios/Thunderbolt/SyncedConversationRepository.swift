/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

@MainActor
final class SyncedConversationStore: ConversationStoring {
    let store: NativeSyncStore
    private let owner: String
    private let userID: String
    private var baseline: [String: NativeSyncRow] = [:]
    private var writeTail: Task<Void, Error>?
    private var writeID: UUID?

    init(store: NativeSyncStore, owner: String, userID: String) {
        self.store = store
        self.owner = owner
        self.userID = userID
    }

    func load(owner: String) async throws -> [Conversation] {
        try await readHistory(owner: owner, updateBaseline: true)
    }

    func snapshot(owner: String) async throws -> [Conversation] {
        try await readHistory(owner: owner, updateBaseline: false)
    }

    private func readHistory(owner: String, updateBaseline: Bool) async throws -> [Conversation] {
        guard owner == self.owner else { throw NativeSyncStoreError.ownerMismatch }
        async let threads = store.readAll(table: "chat_threads", includeDeleted: true)
        async let messages = store.readAll(table: "chat_messages", includeDeleted: true)
        let (threadRows, messageRows) = try await (threads, messages)
        let conversations = try ConversationRecords.decode(threads: threadRows, messages: messageRows)
        if updateBaseline {
            baseline = Dictionary(uniqueKeysWithValues: (threadRows + messageRows).map { (Self.key($0), $0) })
            try accept(conversations)
        }
        return conversations
    }

    /// The UI acknowledges a remote snapshot only when it can display it. A
    /// snapshot arriving during a local write must not silently change the base
    /// against which that user's edit is compared.
    func accept(_ conversations: [Conversation]) throws {
        for conversation in conversations {
            let rows = [ConversationRecords.thread(conversation, userID: userID)]
                + (try conversation.messages.map { try ConversationRecords.message($0, threadID: conversation.id, userID: userID) })
            for row in rows {
                let key = Self.key(row)
                let values = (baseline[key]?.values ?? [:]).merging(row.values) { _, new in new }
                baseline[key] = NativeSyncRow(table: row.table, id: row.id, values: values)
            }
        }
    }

    func save(_ conversations: [Conversation], owner: String) async throws {
        guard owner == self.owner else { throw NativeSyncStoreError.ownerMismatch }
        var rows: [NativeSyncRow] = []
        for conversation in conversations {
            rows.append(ConversationRecords.thread(conversation, userID: userID))
            rows += try conversation.messages.map { try ConversationRecords.message($0, threadID: conversation.id, userID: userID) }
        }
        // Only changed columns are written. A streamed message must not overwrite a
        // concurrent title/project change or clear fields introduced by another client.
        let changed = rows.compactMap { row -> NativeSyncMutation? in
            let old = baseline[Self.key(row)]
            var fields = row.values.filter { old?.values[$0.key] != $0.value }
            guard !fields.isEmpty else { return nil }
            fields["user_id"] = .text(userID)
            return NativeSyncMutation(table: row.table, id: row.id, values: fields)
        }
        guard !changed.isEmpty else { return }
        let predecessor = writeTail
        let id = UUID()
        let task = Task { @MainActor in
            // A failed write is surfaced to its caller; a later explicit retry
            // must still be able to proceed after it.
            if let predecessor { _ = await predecessor.result }
            try await self.store.writeTransaction(changed)
            for mutation in changed {
                let key = mutation.table + ":" + mutation.id
                let values = (self.baseline[key]?.values ?? [:]).merging(mutation.values) { _, value in value }
                self.baseline[key] = NativeSyncRow(table: mutation.table, id: mutation.id, values: values)
            }
        }
        writeTail = task
        writeID = id
        defer { if writeID == id { writeTail = nil; writeID = nil } }
        try await task.value
    }

    func changes() async throws -> AsyncThrowingStream<[Conversation], Error> {
        let threads = try await store.watch(table: "chat_threads", includeDeleted: true)
        let messages = try await store.watch(table: "chat_messages", includeDeleted: true)
        return AsyncThrowingStream { continuation in
            let tasks = [threads, messages].map { source in
                Task { @MainActor in
                    do {
                        for try await _ in source {
                            try Task.checkCancellation()
                            continuation.yield(try await self.readHistory(owner: self.owner, updateBaseline: false))
                        }
                    } catch is CancellationError {
                    } catch { continuation.finish(throwing: error) }
                }
            }
            continuation.onTermination = { _ in tasks.forEach { $0.cancel() } }
        }
    }

    private static func key(_ row: NativeSyncRow) -> String { row.table + ":" + row.id }
}

enum ConversationRecordError: Error {
    case invalidMessageRole(String)
    case invalidJSON(column: String, rowID: String)
    case invalidTimestamp(String)
}

/// Maps the existing Tauri tables without adding native-only synced columns. Message
/// order and activity dates come from UUIDv7 ids, exactly as they do in the Tauri DAL.
enum ConversationRecords {
    static func decode(threads: [NativeSyncRow], messages: [NativeSyncRow]) throws -> [Conversation] {
        // Tauri scrubs nullable fields on soft deletion, including the role and
        // parts. Tombstones remain in the raw baseline but are not messages.
        let liveMessages = messages.filter { $0.values["deleted_at"]?.text == nil }
        let byThread = Dictionary(grouping: liveMessages) { $0.values["chat_thread_id"]?.text ?? "" }
        return try threads.map { row in
            let decoded = try (byThread[row.id] ?? []).sorted { $0.id < $1.id }.map(decodeMessage)
            let created = ChronologicalID.date(from: row.id) ?? .distantPast
            let activity = decoded.filter { $0.deletedAt == nil }.map(\.createdAt).max() ?? created
            return Conversation(
                id: row.id,
                title: row.values["title"]?.text ?? nativeString( "New chat"),
                updatedAt: max(created, activity),
                deletedAt: try date(row.values["deleted_at"]?.text),
                messages: decoded,
                modelID: decoded.last(where: { $0.deletedAt == nil && $0.modelID != nil })?.modelID,
                agentID: row.values["agent_id"]?.text,
                projectID: row.values["project_id"]?.text,
                isPrivate: row.values["is_encrypted"] == .integer(1),
                contextSize: row.values["context_size"]?.integer
            )
        }.sorted { $0.updatedAt > $1.updatedAt }
    }

    static func decodeMessage(_ row: NativeSyncRow) throws -> ChatMessage {
        let roleValue = row.values["role"]?.text ?? ""
        guard let role = MessageRole(rawValue: roleValue) else {
            throw ConversationRecordError.invalidMessageRole(roleValue)
        }
        let parts: [ChatContentPart]? = try json(row.values["parts"]?.text, column: "parts", rowID: row.id)
        let metadata: ChatJSONValue? = try json(row.values["metadata"]?.text, column: "metadata", rowID: row.id)
        let cache: ChatJSONValue? = try json(row.values["cache"]?.text, column: "cache", rowID: row.id)
        return ChatMessage(
            id: row.id, role: role,
            text: row.values["content"]?.text ?? parts?.filter(\.isText).compactMap(\.text).joined(separator: "\n") ?? "",
            createdAt: ChronologicalID.date(from: row.id) ?? .distantPast,
            deletedAt: try date(row.values["deleted_at"]?.text),
            parts: parts, metadata: metadata, cache: cache,
            parentID: row.values["parent_id"]?.text,
            modelID: row.values["model_id"]?.text
        )
    }

    static func thread(_ conversation: Conversation, userID: String) -> NativeSyncRow {
        if let deletedAt = conversation.deletedAt {
            return tombstone(table: "chat_threads", id: conversation.id, userID: userID, date: deletedAt)
        }
        return NativeSyncRow(table: "chat_threads", id: conversation.id, values: [
            "title": .text(conversation.title), "user_id": .text(userID),
            "agent_id": .optional(conversation.agentID), "project_id": .optional(conversation.projectID),
            "is_encrypted": .integer(conversation.isPrivate == true ? 1 : 0),
            "context_size": conversation.contextSize.map(NativeSyncValue.integer) ?? .null,
            "deleted_at": .optional(conversation.deletedAt.map(timestamp)),
        ])
    }

    static func message(_ message: ChatMessage, threadID: String, userID: String) throws -> NativeSyncRow {
        if let deletedAt = message.deletedAt {
            return tombstone(table: "chat_messages", id: message.id, userID: userID, date: deletedAt)
        }
        let parts = message.parts ?? [ChatContentPart(rawValue: .object([
            "type": .string("text"), "text": .string(message.text),
        ]), fallbackID: "text-0")]
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let encodedParts = String(decoding: try encoder.encode(parts), as: UTF8.self)
        let encodedMetadata = try message.metadata.map { String(decoding: try encoder.encode($0), as: UTF8.self) }
        let encodedCache = try message.cache.map { String(decoding: try encoder.encode($0), as: UTF8.self) }
        return NativeSyncRow(table: "chat_messages", id: message.id, values: [
            "content": .text(message.text), "role": .text(message.role.rawValue),
            "parts": .text(encodedParts), "metadata": .optional(encodedMetadata),
            "cache": .optional(encodedCache),
            "chat_thread_id": .text(threadID), "user_id": .text(userID),
            "parent_id": .optional(message.parentID), "model_id": .optional(message.modelID),
            "deleted_at": .optional(message.deletedAt.map(timestamp)),
        ])
    }

    private static func tombstone(table: String, id: String, userID: String, date: Date) -> NativeSyncRow {
        let columns = NativePowerSyncSchema.byName[table]!.columns
        var values = Dictionary(uniqueKeysWithValues: columns.map { ($0.name, NativeSyncValue.null) })
        values["user_id"] = .text(userID)
        values["deleted_at"] = .text(timestamp(date))
        return NativeSyncRow(table: table, id: id, values: values)
    }

    /// Prototype ids were random UUIDs; Tauri extracts dates and order from v7 ids.
    /// Build a stable mapping for this migration batch and keep every branch parent.
    static func migratePrototype(_ conversations: [Conversation]) -> [Conversation] {
        return conversations.sorted { $0.updatedAt < $1.updatedAt }.map { original in
            let generator = ChronologicalID()
            var conversation = original
            if ChronologicalID.date(from: conversation.id) == nil {
                conversation.id = generator.next(at: conversation.messages.first?.createdAt ?? conversation.updatedAt)
            }
            let ids = Dictionary(uniqueKeysWithValues: original.messages.map {
                ($0.id, ChronologicalID.date(from: $0.id) == nil ? generator.next(at: $0.createdAt) : $0.id)
            })
            conversation.messages = original.messages.enumerated().map { index, originalMessage in
                var message = originalMessage
                message.id = ids[originalMessage.id]!
                message.parentID = originalMessage.parentID.flatMap { ids[$0] ?? $0 }
                    ?? (index > 0 ? ids[original.messages[index - 1].id] : nil)
                message.modelID = message.modelID ?? original.modelID
                return message
            }
            return conversation
        }
    }

    private static func json<Value: Decodable>(_ value: String?, column: String, rowID: String) throws -> Value? {
        guard let value else { return nil }
        do { return try JSONDecoder().decode(Value?.self, from: Data(value.utf8)) }
        catch { throw ConversationRecordError.invalidJSON(column: column, rowID: rowID) }
    }

    private static func timestamp(_ date: Date) -> String { date.ISO8601Format() }

    private static func date(_ text: String?) throws -> Date? {
        guard let text else { return nil }
        let normalized = text.contains("T") ? text : text.replacingOccurrences(of: " ", with: "T") + "Z"
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: normalized) { return date }
        formatter.formatOptions.insert(.withFractionalSeconds)
        guard let date = formatter.date(from: normalized) else { throw ConversationRecordError.invalidTimestamp(text) }
        return date
    }
}

extension NativeSyncValue {
    var integer: Int64? {
        guard case .integer(let number) = self else { return nil }
        return number
    }
    var text: String? {
        guard case .text(let string) = self else { return nil }
        return string
    }
    static func optional(_ value: String?) -> NativeSyncValue { value.map(Self.text) ?? .null }
}
