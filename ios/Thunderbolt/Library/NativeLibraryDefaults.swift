/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

struct NativeDefaultsTable: Codable, Sendable {
    let table: String
    let version: Int
    let rows: [NativeDefaultRow]
}

struct NativeDefaultRow: Codable, Sendable {
    let id: String
    let values: [String: ChatJSONValue]
    let hash: String
    let hashColumns: [String]
    let frozenColumns: [String]
    let skipWhenMissing: Bool
}

enum NativeLibraryDefaults {
    static func load() throws -> [NativeDefaultsTable] {
        guard let url = Bundle.main.url(forResource: "LibraryDefaults", withExtension: "json") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode([NativeDefaultsTable].self, from: Data(contentsOf: url))
    }

    /// JavaScript's shared hashValues operates on UTF-16 code units with signed
    /// 32-bit overflow. This preserves the same edit markers on every client.
    static func hash(id: String, values: [String: NativeSyncValue], columns: [String]) -> String {
        let source = columns.map { column -> String in
            if column == "$id" { return id }
            switch values[column] ?? .null {
            case .text(let value): return value
            case .integer(let value): return String(value)
            case .real(let value): return value.rounded() == value ? String(format: "%.0f", value) : String(value)
            case .null: return ""
            }
        }.joined(separator: "|")
        var result: Int32 = 0
        for unit in source.utf16 { result = (result &* 31) &+ Int32(unit) }
        return String(result, radix: 36)
    }

    static func values(_ row: NativeDefaultRow) throws -> [String: NativeSyncValue] {
        try row.values.mapValues {
            switch $0 {
            case .null: .null
            case .string(let value): .text(value)
            case .number(let value) where value.rounded() == value && abs(value) < 9_007_199_254_740_992: .integer(Int64(value))
            case .number(let value): .real(value)
            default: throw CocoaError(.coderInvalidValue)
            }
        }
    }

    /// Mirrors the version/sync gate used by Tauri's generic default reconciler.
    /// User-edited content and scrubbed tombstones remain under user control.
    static func reconcile(_ tables: [NativeDefaultsTable], store: NativeSyncStore, userID: String, initialSyncCompleted: Bool) async throws {
        var initialRows: [String: [NativeSyncRow]] = [:]
        for table in tables {
            initialRows[table.table] = try await store.readAll(table: table.table, includeDeleted: true)
                .filter { $0.values["user_id"] == .text(userID) }
        }
        for table in tables {
            let rows = initialRows[table.table] ?? []
            let markerID = "defaults_version." + table.table
            let marker = try await store.read(table: "settings", id: markerID)
            let storedVersion = marker?.values["value"]?.text.flatMap(Int.init)
            let canOverwrite = table.version > (storedVersion ?? -1) && (rows.isEmpty || initialSyncCompleted)
            guard canOverwrite || initialSyncCompleted else { continue }
            let existingByID = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
            var changes: [NativeSyncMutation] = []
            var allAtTarget = true
            for entry in table.rows {
                let defaultValues = try values(entry)
                guard let existing = existingByID[entry.id] else {
                    if entry.skipWhenMissing { continue }
                    guard canOverwrite else { allAtTarget = false; continue }
                    var newValues = defaultValues
                    newValues["user_id"] = .text(userID)
                    newValues["default_hash"] = .text(entry.hash)
                    changes.append(.init(table: table.table, id: entry.id, values: newValues))
                    continue
                }
                var current = existing.values
                var oldHash = current["default_hash"]?.text
                if table.table == "skills", !entry.frozenColumns.isEmpty, let stamped = oldHash {
                    let legacyColumns = ["name", "label", "description", "instruction", "enabled", "pinned_order", "deleted_at"]
                    if hash(id: entry.id, values: current, columns: legacyColumns) == stamped {
                        oldHash = hash(id: entry.id, values: current, columns: entry.hashColumns)
                        current["default_hash"] = oldHash.map(NativeSyncValue.text) ?? .null
                        changes.append(.init(table: table.table, id: entry.id, values: ["default_hash": current["default_hash"]!]))
                    }
                }
                var liveValues = current
                liveValues["deleted_at"] = .null
                if current["deleted_at"]?.text != nil, let oldHash,
                   hash(id: entry.id, values: liveValues, columns: entry.hashColumns) == oldHash {
                    if initialSyncCompleted { changes.append(.init(table: table.table, id: entry.id, values: ["deleted_at": .null])) }
                    else { allAtTarget = false }
                    continue
                }
                guard canOverwrite else { allAtTarget = false; continue }
                guard let oldHash else {
                    changes.append(.init(table: table.table, id: entry.id, values: ["default_hash": .text(entry.hash)]))
                    continue
                }
                var effective = defaultValues
                for column in entry.frozenColumns { effective[column] = current[column] ?? .null }
                let effectiveHash = hash(id: entry.id, values: effective, columns: entry.hashColumns)
                let currentHash = hash(id: entry.id, values: current, columns: entry.hashColumns)
                guard currentHash == oldHash || currentHash == effectiveHash else { allAtTarget = false; continue }
                if oldHash == effectiveHash { continue }
                if table.table == "settings", current["value"] != .null, effective["value"] == .null { continue }
                effective["user_id"] = .text(userID)
                effective["default_hash"] = .text(effectiveHash)
                changes.append(.init(table: table.table, id: entry.id, values: effective))
            }
            if canOverwrite && (!changes.isEmpty || allAtTarget) {
                changes.append(.init(table: "settings", id: markerID, values: [
                    "value": .text(String(table.version)), "user_id": .text(userID),
                ]))
            }
            if !changes.isEmpty { try await store.writeTransaction(changes) }
        }
    }
}
