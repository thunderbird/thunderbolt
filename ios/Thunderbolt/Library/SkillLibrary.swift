/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Observation

struct NativeSkill: Identifiable, Equatable, Sendable {
    var id = ChronologicalID.shared.next()
    var name = ""
    var label = ""
    var description = ""
    var instruction = ""
    var enabled = true
    var pinnedOrder: Int64?
    var isWidget = false
    var displayName: String { label.isEmpty ? name : label }
    var definition: ChatJSONValue { .object([
        "name": .string(name), "description": .string(description), "instruction": .string(instruction),
    ]) }
}

enum NativeSkillError: LocalizedError {
    case invalidName, duplicateName, lockedWidget, pinLimit, pinOrderChanged
    var errorDescription: String? {
        switch self {
        case .invalidName: nativeString( "Use 1–64 lowercase letters, numbers, or single hyphens for the slug. Start and end with a letter or number.")
        case .duplicateName: nativeString( "A skill with this slug already exists.")
        case .lockedWidget: nativeString( "Widget instructions are managed by Thunderbolt. You can enable or disable the widget.")
        case .pinLimit: nativeString( "You can pin up to 10 skills. Unpin one to add another.")
        case .pinOrderChanged: nativeString("Your pinned skills changed. Try again.")
        }
    }
}

@MainActor
@Observable
final class SkillLibrary {
    private(set) var skills: [NativeSkill] = []
    var error: String?
    private let store: NativeSyncStore
    private let userID: String
    private let widgetIDs: Set<String>
    @ObservationIgnored private var watcher: Task<Void, Never>?

    init(store: NativeSyncStore, userID: String, defaults: [NativeDefaultsTable]) {
        self.store = store
        self.userID = userID
        widgetIDs = Set(defaults.first { $0.table == "skills" }?.rows.filter { !$0.frozenColumns.isEmpty }.map(\.id) ?? [])
    }

    var enabled: [NativeSkill] { skills.filter(\.enabled) }
    var pinned: [NativeSkill] { skills.filter { $0.enabled && $0.pinnedOrder != nil }.sorted { $0.pinnedOrder! < $1.pinnedOrder! } }

    func start() {
        guard watcher == nil else { return }
        watcher = Task { [weak self, store] in
            do {
                for try await rows in try await store.watch(table: "skills") {
                    guard let self, !Task.isCancelled else { return }
                    skills = rows.filter { $0.values["user_id"] == .text(userID) }.map(decode)
                        .sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
                }
            } catch is CancellationError {
            } catch { self?.error = error.localizedDescription }
        }
    }

    func stop() { watcher?.cancel(); watcher = nil; skills = [] }

    func save(_ skill: NativeSkill) async throws {
        guard !widgetIDs.contains(skill.id) else { throw NativeSkillError.lockedWidget }
        guard Self.validName(skill.name) else { throw NativeSkillError.invalidName }
        let rows = try await store.readAll(table: "skills", includeDeleted: true)
        guard !rows.contains(where: { $0.id != skill.id && $0.values["name"] == .text(skill.name) }) else { throw NativeSkillError.duplicateName }
        var values: [String: NativeSyncValue] = [
            "user_id": .text(userID), "name": .text(skill.name), "label": .text(skill.label),
            "description": .text(skill.description), "instruction": .text(skill.instruction),
        ]
        if !rows.contains(where: { $0.id == skill.id }) {
            values["enabled"] = .integer(skill.enabled ? 1 : 0)
            values["pinned_order"] = .null
        }
        try await store.write(table: "skills", id: skill.id, values: values)
    }

    func setEnabled(_ skill: NativeSkill, value: Bool) async throws {
        var values: [String: NativeSyncValue] = ["enabled": .integer(value ? 1 : 0)]
        if !value { values["pinned_order"] = .null }
        try await store.write(table: "skills", id: skill.id, values: values)
    }

    func togglePin(_ skill: NativeSkill) async throws {
        guard skill.pinnedOrder == nil else {
            try await store.write(table: "skills", id: skill.id, values: ["pinned_order": .null])
            return
        }
        guard !widgetIDs.contains(skill.id) else { throw NativeSkillError.lockedWidget }
        let rows = try await store.readAll(table: "skills")
        let orders = rows.compactMap { row -> Int64? in
            if case .integer(let value)? = row.values["pinned_order"] { return value }
            return nil
        }
        guard orders.count < 10 else { throw NativeSkillError.pinLimit }
        try await store.write(table: "skills", id: skill.id, values: [
            "enabled": .integer(1), "pinned_order": .integer((orders.max() ?? -1) + 1),
        ])
    }

    func delete(_ skill: NativeSkill) async throws {
        guard !widgetIDs.contains(skill.id) else { throw NativeSkillError.lockedWidget }
        try await store.write(table: "skills", id: skill.id, values: [
            "name": .null, "label": .null, "description": .null, "instruction": .null,
            "pinned_order": .null, "deleted_at": .text(Date().ISO8601Format()),
        ])
    }

    /// Reorders the current pin set atomically while retaining locked widget positions.
    func reorderPins(_ ids: [String]) async throws {
        let rows = try await store.readAll(table: "skills")
        let existing = rows.filter { $0.values["user_id"] == .text(userID) }.map(decode)
            .filter { $0.pinnedOrder != nil }.sorted { $0.pinnedOrder! < $1.pinnedOrder! }
        guard ids.count <= 10, ids.count == existing.count, Set(ids).count == ids.count,
              Set(ids) == Set(existing.map(\.id)) else { throw NativeSkillError.pinOrderChanged }
        for (index, skill) in existing.enumerated() where skill.isWidget {
            guard ids[index] == skill.id, Set(ids.prefix(index)) == Set(existing.prefix(index).map(\.id)) else {
                throw NativeSkillError.lockedWidget
            }
        }
        let staged = ids.enumerated().map { index, id in
            NativeSyncMutation(table: "skills", id: id, values: ["pinned_order": .integer(Int64(-1 - index))])
        }
        let final = ids.enumerated().map { index, id in
            NativeSyncMutation(table: "skills", id: id, values: ["pinned_order": .integer(Int64(index))])
        }
        try await store.writeTransaction(staged + final)
    }

    /// Resolves standalone slash tokens only, without rewriting the user's text.
    /// URLs, paths, punctuation-suffixed tokens, and disabled skills stay literal.
    func instructions(in text: String) -> [String] {
        Self.tokens(in: text).compactMap { slug in
            guard let instruction = enabled.first(where: { $0.name == slug })?.instruction, !instruction.isEmpty else { return nil }
            return instruction
        }
    }

    static func tokens(in text: String) -> [String] {
        let pattern = try! NSRegularExpression(pattern: #"(?:^|\s)/([A-Za-z0-9_-]+)(?=\s|$)"#)
        var seen: Set<String> = []
        return pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            guard let range = Range(match.range(at: 1), in: text) else { return nil }
            let slug = String(text[range])
            return seen.insert(slug).inserted ? slug : nil
        }
    }

    static func validName(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 64 && value.first != "-" && value.last != "-" && !value.contains("--") &&
            value.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
    }

    private func decode(_ row: NativeSyncRow) -> NativeSkill {
        let order: Int64?
        if case .integer(let value)? = row.values["pinned_order"] { order = value } else { order = nil }
        return NativeSkill(id: row.id, name: row.values["name"]?.text ?? "", label: row.values["label"]?.text ?? "",
            description: row.values["description"]?.text ?? "", instruction: row.values["instruction"]?.text ?? "",
            enabled: row.values["enabled"] == .integer(1), pinnedOrder: order, isWidget: widgetIDs.contains(row.id))
    }
}
