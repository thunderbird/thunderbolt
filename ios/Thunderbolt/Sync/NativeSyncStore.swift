// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import Foundation
import PowerSync

protocol NativeSyncRowCodec: Sendable {
    func isEncryptionConfigured() async throws -> Bool
    func isReadyForSync() async throws -> Bool
    func encode(_ plaintext: String, context: E2EEContext) async throws -> String
    func decode(_ encoded: String, context: E2EEContext?) async throws -> String
    func isEncryptedValue(_ value: String) -> Bool
    func isValidV2Ciphertext(_ value: String) -> Bool
}

enum NativeSyncValue: Sendable, Equatable {
    case text(String)
    case integer(Int64)
    case real(Double)
    case null

    var jsonValue: JsonValue {
        switch self {
        case .text(let value): .string(value)
        case .integer(let value): .int(Int(value))
        case .real(let value): .double(value)
        case .null: .null
        }
    }

    fileprivate var sqliteParameter: (any Sendable)? {
        switch self {
        case .text(let value): value
        case .integer(let value): value
        case .real(let value): value
        case .null: nil
        }
    }
}

struct NativeSyncRow: Sendable, Equatable {
    let table: String
    let id: String
    let values: [String: NativeSyncValue]
}

/// A value snapshot of PowerSync's live status, suitable for UI and bootstrap decisions.
struct NativeSyncStatusSnapshot: Sendable, Equatable {
    let connected: Bool
    let connecting: Bool
    let downloading: Bool
    let uploading: Bool
    let hasSynced: Bool?
    let lastSyncedAt: Date?
    let hasError: Bool

    var initialSyncCompleted: Bool { hasSynced == true }

    fileprivate init(status: any SyncStatusData) {
        connected = status.connected
        connecting = status.connecting
        downloading = status.downloading
        uploading = status.uploading
        hasSynced = status.hasSynced
        lastSyncedAt = status.lastSyncedAt
        hasError = status.anyError != nil
    }
}

struct NativeSyncMutation: Sendable {
    let table: String
    let id: String
    let values: [String: NativeSyncValue]
}

struct NativeSystemAgentCacheEntry: Sendable, Equatable {
    let id: String
    let name: String
    let type: String
    let transport: String
    let url: String
    let description: String?
    let icon: String?
    let fetchedAt: String
    let isDefault: Bool
}

enum NativeSyncStoreError: Error, Equatable {
    case unknownTable(String)
    case unknownColumn(table: String, column: String)
    case invalidValue(table: String, column: String)
    case missingRowID
    case missingOwner
    case ownerMismatch
    case encryptionUnavailable(table: String, column: String)
    case plaintextOnEncryptedColumn(table: String, column: String)
    case decryptionUnavailable(table: String, column: String)
    case softDeleteUnsupported(String)
    case hardDeleteUnsupported(String)
    case syncNotReady(NativeSyncReadiness)
    case rowChanged(table: String, id: String)
}

/// Local-first typed access to PowerSync's SQLite views. Callers do not get the raw
/// database handle: encrypted values are sealed before writes and opened before reads.
actor NativeSyncStore {
    private let database: any PowerSyncDatabaseProtocol
    private let codec: (any NativeSyncRowCodec)?
    private let trustedDevice: @Sendable () async throws -> Bool
    private let ownerID: String?

    init(
        database: any PowerSyncDatabaseProtocol,
        ownerID: String?,
        codec: (any NativeSyncRowCodec)?,
        trustedDevice: @escaping @Sendable () async throws -> Bool
    ) {
        self.database = database
        self.ownerID = ownerID
        self.codec = codec
        self.trustedDevice = trustedDevice
    }

    static func open(
        ownerID: String?,
        codec: (any NativeSyncRowCodec)?,
        trustedDevice: @escaping @Sendable () async throws -> Bool,
        dbFilename: String = "thunderbolt-native.sqlite"
    ) -> NativeSyncStore {
        NativeSyncStore(
            database: PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: dbFilename),
            ownerID: ownerID,
            codec: codec,
            trustedDevice: trustedDevice
        )
    }

    var readiness: NativeSyncReadiness {
        get async {
            do {
                guard ownerID != nil else { return .localOnly }
                guard try await trustedDevice() else { return .waitingForTrustedDevice }
                guard let codec, try await codec.isReadyForSync() else { return .waitingForCodec }
                return .ready
            } catch {
                return .failed(error.localizedDescription)
            }
        }
    }

    func syncStatusSnapshot() -> NativeSyncStatusSnapshot {
        NativeSyncStatusSnapshot(status: database.currentStatus)
    }

    /// Emits the current status followed by SDK status changes; cancellation detaches the observer.
    func watchSyncStatus() -> AsyncStream<NativeSyncStatusSnapshot> {
        let status = database.currentStatus
        return AsyncStream { continuation in
            let task = Task {
                continuation.yield(NativeSyncStatusSnapshot(status: status))
                for await update in status.asFlow() {
                    continuation.yield(NativeSyncStatusSnapshot(status: update))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func write(table tableName: String, id: String, values input: [String: NativeSyncValue]) async throws {
        try await writeTransaction([NativeSyncMutation(table: tableName, id: id, values: input)])
    }

    /// Applies related local changes in one SQLite transaction, such as a chat
    /// thread and its first user message. PowerSync records CRUD for later sync.
    func writeTransaction(_ mutations: [NativeSyncMutation]) async throws {
        var prepared: [PreparedSyncMutation] = []
        prepared.reserveCapacity(mutations.count)
        for mutation in mutations { prepared.append(try await prepare(mutation)) }
        let ownerID = self.ownerID
        let committedMutations = prepared
        try await database.writeTransaction { transaction in
            for mutation in committedMutations {
                if !mutation.table.localOnly {
                    guard let ownerID else { throw NativeSyncStoreError.missingOwner }
                    let existingOwner = try transaction.getOptional(
                        sql: "SELECT user_id FROM \(Self.quoteIdentifier(mutation.table.name)) WHERE id = ? LIMIT 1",
                        parameters: [mutation.id]
                    ) { $0.getStringOptional(index: 0) }
                    if let existingOwner {
                        guard existingOwner == ownerID else { throw NativeSyncStoreError.ownerMismatch }
                        if let proposed = mutation.values["user_id"], proposed != .text(ownerID) {
                            throw NativeSyncStoreError.ownerMismatch
                        }
                    } else {
                        guard mutation.values["user_id"] == .text(ownerID) else { throw NativeSyncStoreError.ownerMismatch }
                    }
                }
                try Self.apply(mutation, in: transaction)
            }
        }
    }

    /// Atomically updates a local-only row only when its expected credential fields still match.
    func compareAndWriteLocal(
        table tableName: String,
        id: String,
        expected: [String: NativeSyncValue],
        values: [String: NativeSyncValue]
    ) async throws {
        let prepared = try await prepare(NativeSyncMutation(table: tableName, id: id, values: values))
        guard prepared.table.localOnly else { throw NativeSyncStoreError.unknownTable(tableName) }
        try await database.writeTransaction { transaction in
            let current = try transaction.getOptional(
                sql: "SELECT * FROM \(Self.quoteIdentifier(tableName)) WHERE id = ? LIMIT 1",
                parameters: [id]
            ) { try Self.readRow($0, table: prepared.table) }
            guard let current,
                  expected.allSatisfy({ current.values[$0.key] == $0.value }) else {
                throw NativeSyncStoreError.rowChanged(table: tableName, id: id)
            }
            try Self.apply(prepared, in: transaction)
        }
    }

    func read(table tableName: String, id: String) async throws -> NativeSyncRow? {
        let table = try definition(named: tableName)
        let sql = "SELECT * FROM \(Self.quoteIdentifier(tableName)) WHERE id = ? LIMIT 1"
        let record = try await database.getOptional(sql: sql, parameters: [id]) { cursor in
            try Self.readRow(cursor, table: table)
        }
        guard let record else { return nil }
        return try await decode(record, definition: table)
    }

    func readAll(table tableName: String, includeDeleted: Bool = false) async throws -> [NativeSyncRow] {
        let table = try definition(named: tableName)
        let deletedFilter = table.hasSoftDelete && !includeDeleted ? " WHERE deleted_at IS NULL" : ""
        let records = try await database.getAll(
            "SELECT * FROM \(Self.quoteIdentifier(tableName))\(deletedFilter) ORDER BY id",
            mapper: { cursor in try Self.readRow(cursor, table: table) }
        )
        var rows: [NativeSyncRow] = []
        rows.reserveCapacity(records.count)
        for record in records { rows.append(try await decode(record, definition: table)) }
        return rows
    }

    func watch(table tableName: String, includeDeleted: Bool = false) throws -> AsyncThrowingStream<[NativeSyncRow], Error> {
        let table = try definition(named: tableName)
        let deletedFilter = table.hasSoftDelete && !includeDeleted ? " WHERE deleted_at IS NULL" : ""
        let source = try database.watch(
            "SELECT * FROM \(Self.quoteIdentifier(tableName))\(deletedFilter) ORDER BY id",
            mapper: { cursor in try Self.readRow(cursor, table: table) }
        )
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await records in source {
                        var rows: [NativeSyncRow] = []
                        rows.reserveCapacity(records.count)
                        for record in records { rows.append(try await decode(record, definition: table)) }
                        continuation.yield(rows)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func softDelete(table tableName: String, id: String, at date: Date = Date()) async throws {
        let table = try definition(named: tableName)
        guard table.hasSoftDelete else { throw NativeSyncStoreError.softDeleteUnsupported(tableName) }
        let ownerClause: String
        let parameters: [any Sendable]
        if table.localOnly {
            ownerClause = ""
            parameters = [Self.timestamp(date), id]
        } else {
            guard let ownerID else { throw NativeSyncStoreError.missingOwner }
            ownerClause = " AND user_id = ?"
            parameters = [Self.timestamp(date), id, ownerID]
        }
        try await database.execute(
            sql: "UPDATE \(Self.quoteIdentifier(tableName)) SET deleted_at = ? WHERE id = ?\(ownerClause)",
            parameters: parameters
        )
    }

    /// Atomically refreshes the local-only `/agents` discovery cache. This
    /// deliberately is not a generic local-row delete API: the only cache rows
    /// removed here are server descriptors for managed agents.
    func replaceSystemAgentCache(_ rows: [NativeSystemAgentCacheEntry]) async throws {
        let table = try definition(named: "agents_system")
        guard table.localOnly else { throw NativeSyncStoreError.unknownTable("agents_system") }
        let current = try await readAll(table: "agents_system")
        let incomingByID = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
        let changedIDs = current.compactMap { row -> String? in
            guard let incoming = incomingByID[row.id] else { return nil }
            let oldURL = row.values["url"]?.text
            let oldTransport = row.values["transport"]?.text
            return oldURL != incoming.url || oldTransport != incoming.transport ? row.id : nil
        }
        let changes = changedIDs
        try await database.writeTransaction { transaction in
            for id in changes {
                try transaction.execute(
                    sql: "UPDATE \(Self.quoteIdentifier("chat_threads")) SET acp_session_id = NULL WHERE agent_id = ?",
                    parameters: [id]
                )
            }
            try transaction.execute(sql: "DELETE FROM \(Self.quoteIdentifier("agents_system"))", parameters: [])
            for row in rows {
                let mutation = PreparedSyncMutation(
                    table: table,
                    id: row.id,
                    values: [
                        "name": .text(row.name), "type": .text(row.type), "transport": .text(row.transport),
                        "url": .text(row.url), "description": row.description.map(NativeSyncValue.text) ?? .null,
                        "icon": row.icon.map(NativeSyncValue.text) ?? .null, "fetched_at": .text(row.fetchedAt),
                        "is_default": .integer(row.isDefault ? 1 : 0),
                    ]
                )
                try Self.apply(mutation, in: transaction)
            }
        }
    }

    func disconnectAndClear(clearLocal: Bool = false) async throws {
        try await database.disconnectAndClear(clearLocal: clearLocal, soft: false)
    }

    func connect(using connector: NativePowerSyncConnector) async throws -> NativeSyncReadiness {
        let currentReadiness = await readiness
        guard currentReadiness == .ready else { return currentReadiness }
        try await database.connect(connector: connector)
        return .ready
    }

    func disconnect() async throws {
        try await database.disconnect()
    }

    func validateForUpload(_ operation: NativeSyncOperation) async throws {
        guard await readiness == .ready else { throw NativeSyncStoreError.syncNotReady(await readiness) }
        guard operation.op != "DELETE" else { throw NativeSyncStoreError.hardDeleteUnsupported(operation.type) }
        guard let data = operation.data else { return }
        guard let table = NativePowerSyncSchema.byName[operation.type] else {
            throw NativeSyncStoreError.unknownTable(operation.type)
        }
        guard !table.localOnly else { throw NativeSyncStoreError.unknownTable(operation.type) }
        guard let codec else { throw NativeSyncStoreError.syncNotReady(.waitingForCodec) }
        for column in table.encryptedColumns {
            guard let value = data[column] else { continue }
            switch value {
            case .null:
                continue
            case .string(let ciphertext) where codec.isValidV2Ciphertext(ciphertext):
                continue
            default:
                throw NativeSyncStoreError.plaintextOnEncryptedColumn(table: operation.type, column: column)
            }
        }
    }

    private func definition(named name: String) throws -> NativeSyncTable {
        guard let table = NativePowerSyncSchema.byName[name] else { throw NativeSyncStoreError.unknownTable(name) }
        return table
    }

    private func prepare(_ mutation: NativeSyncMutation) async throws -> PreparedSyncMutation {
        guard !mutation.id.isEmpty else { throw NativeSyncStoreError.missingRowID }
        let table = try definition(named: mutation.table)
        var values = mutation.values
        for (column, value) in values {
            guard let definition = table.column(named: column) else {
                throw NativeSyncStoreError.unknownColumn(table: mutation.table, column: column)
            }
            guard matches(value, type: definition.type) else {
                throw NativeSyncStoreError.invalidValue(table: mutation.table, column: column)
            }
        }
        for column in table.encryptedColumns {
            guard case .text(let plaintext)? = values[column] else { continue }
            guard let codec else {
                throw NativeSyncStoreError.encryptionUnavailable(table: table.name, column: column)
            }
            guard try await codec.isReadyForSync() else {
                throw NativeSyncStoreError.encryptionUnavailable(table: table.name, column: column)
            }
            let ciphertext = try await codec.encode(
                plaintext,
                context: E2EEContext(table: table.name, column: column, rowID: mutation.id)
            )
            guard codec.isValidV2Ciphertext(ciphertext) else {
                throw NativeSyncStoreError.encryptionUnavailable(table: table.name, column: column)
            }
            values[column] = .text(ciphertext)
        }
        return PreparedSyncMutation(table: table, id: mutation.id, values: values)
    }

    private static func apply(_ mutation: PreparedSyncMutation, in transaction: any Transaction) throws {
        let tableName = quoteIdentifier(mutation.table.name)
        let exists = try transaction.getOptional(
            sql: "SELECT id FROM \(tableName) WHERE id = ? LIMIT 1",
            parameters: [mutation.id]
        ) { try $0.getString(index: 0) } != nil
        let columns = mutation.values.keys.sorted()
        if exists {
            guard !columns.isEmpty else { return }
            let assignments = columns.map { "\(quoteIdentifier($0)) = ?" }.joined(separator: ", ")
            let parameters = columns.map { mutation.values[$0]!.sqliteParameter } + [mutation.id as any Sendable]
            try transaction.execute(sql: "UPDATE \(tableName) SET \(assignments) WHERE id = ?", parameters: parameters)
            return
        }
        let names = (["id"] + columns).map(quoteIdentifier).joined(separator: ", ")
        let placeholders = Array(repeating: "?", count: columns.count + 1).joined(separator: ", ")
        let parameters = [mutation.id as any Sendable] + columns.map { mutation.values[$0]!.sqliteParameter }
        try transaction.execute(sql: "INSERT INTO \(tableName) (\(names)) VALUES (\(placeholders))", parameters: parameters)
    }

    private func decode(_ row: NativeSyncRow, definition table: NativeSyncTable) async throws -> NativeSyncRow {
        guard let codec else {
            if let column = firstEncryptedColumn(in: row, codec: nil) {
                throw NativeSyncStoreError.decryptionUnavailable(table: table.name, column: column)
            }
            return row
        }
        guard try await codec.isEncryptionConfigured() else {
            if let column = firstEncryptedColumn(in: row, codec: codec) {
                throw NativeSyncStoreError.decryptionUnavailable(table: table.name, column: column)
            }
            return row
        }
        var values = row.values
        for column in table.encryptedColumns {
            guard case .text(let value)? = values[column] else { continue }
            if table.name == "devices", column == "name", !codec.isEncryptedValue(value) { continue }
            guard codec.isEncryptedValue(value) else {
                throw NativeSyncStoreError.plaintextOnEncryptedColumn(table: table.name, column: column)
            }
        }
        for (column, value) in values {
            guard case .text(let ciphertext) = value, codec.isEncryptedValue(ciphertext) else { continue }
            let plaintext = try await codec.decode(ciphertext, context: E2EEContext(table: table.name, column: column, rowID: row.id))
            guard !codec.isEncryptedValue(plaintext) else { throw NativeSyncStoreError.decryptionUnavailable(table: table.name, column: column) }
            values[column] = .text(plaintext)
        }
        return NativeSyncRow(table: row.table, id: row.id, values: values)
    }

    private func firstEncryptedColumn(in row: NativeSyncRow, codec: (any NativeSyncRowCodec)?) -> String? {
        row.values.first { _, value in
            guard case .text(let text) = value else { return false }
            return codec?.isEncryptedValue(text) ?? text.hasPrefix("__enc:")
        }?.key
    }

    private func matches(_ value: NativeSyncValue, type: NativeSyncColumnType) -> Bool {
        switch (value, type) {
        case (.null, _), (.text, .text), (.integer, .integer), (.real, .real): true
        default: false
        }
    }

    private static func readRow(_ cursor: SqlCursor, table: NativeSyncTable) throws -> NativeSyncRow {
        let id = try cursor.getString(name: "id")
        var values: [String: NativeSyncValue] = [:]
        for column in table.columns {
            guard let index = cursor.columnNames[column.name] else { continue }
            switch column.type {
            case .text:
                values[column.name] = cursor.getStringOptional(index: index).map(NativeSyncValue.text) ?? .null
            case .integer:
                values[column.name] = cursor.getInt64Optional(index: index).map(NativeSyncValue.integer) ?? .null
            case .real:
                values[column.name] = cursor.getDoubleOptional(index: index).map(NativeSyncValue.real) ?? .null
            }
        }
        return NativeSyncRow(table: table.name, id: id, values: values)
    }

    private static func quoteIdentifier(_ identifier: String) -> String {
        "\"\(identifier.replacingOccurrences(of: "\"", with: "\"\""))\""
    }

    private static func timestamp(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}

private struct PreparedSyncMutation: Sendable {
    let table: NativeSyncTable
    let id: String
    let values: [String: NativeSyncValue]
}
