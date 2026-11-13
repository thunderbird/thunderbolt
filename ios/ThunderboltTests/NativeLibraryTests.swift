/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
import PowerSync
@testable import Thunderbolt

@MainActor
final class NativeLibraryTests: XCTestCase {
    func testEveryBundledDefaultMatchesItsCanonicalJavaScriptHash() throws {
        for table in try NativeLibraryDefaults.load() {
            for row in table.rows {
                XCTAssertEqual(NativeLibraryDefaults.hash(id: row.id, values: try NativeLibraryDefaults.values(row),
                    columns: row.hashColumns), row.hash, "\(table.table):\(row.id)")
            }
        }
    }

    func testFreshDefaultsDoNotReplaceEditsAndPartialSyncWaits() async throws {
        let store = try await makeStore()
        let tables = try NativeLibraryDefaults.load()
        let skills = try XCTUnwrap(tables.first { $0.table == "skills" })
        let first = try XCTUnwrap(skills.rows.first)
        try await store.write(table: "skills", id: first.id, values: [
            "user_id": .text("user"), "instruction": .text("My edited instructions"), "name": .text("my-skill"),
        ])
        try await NativeLibraryDefaults.reconcile([skills], store: store, userID: "user", initialSyncCompleted: false)
        let partial = try await store.readAll(table: "skills")
        XCTAssertEqual(partial.count, 1)
        let before = try await store.read(table: "settings", id: "defaults_version.skills")
        XCTAssertNil(before)
        try await NativeLibraryDefaults.reconcile([skills], store: store, userID: "user", initialSyncCompleted: true)
        let row = try await store.read(table: "skills", id: first.id)
        XCTAssertEqual(row?.values["instruction"], .text("My edited instructions"))
        let all = try await store.readAll(table: "skills")
        XCTAssertEqual(all.count, skills.rows.count)
    }

    func testDefaultRefreshPreservesWidgetToggleAndScrubbedDeletion() async throws {
        let store = try await makeStore()
        let tables = try NativeLibraryDefaults.load()
        let skills = try XCTUnwrap(tables.first { $0.table == "skills" })
        try await NativeLibraryDefaults.reconcile([skills], store: store, userID: "user", initialSyncCompleted: true)
        let widget = try XCTUnwrap(skills.rows.first { !$0.frozenColumns.isEmpty })
        let ordinary = try XCTUnwrap(skills.rows.first { $0.frozenColumns.isEmpty })
        try await store.write(table: "skills", id: widget.id, values: ["enabled": .integer(0)])
        try await store.write(table: "skills", id: ordinary.id, values: [
            "name": .null, "label": .null, "description": .null, "instruction": .null,
            "deleted_at": .text(Date().ISO8601Format()),
        ])
        let newer = NativeDefaultsTable(table: skills.table, version: skills.version + 1, rows: skills.rows)
        try await NativeLibraryDefaults.reconcile([newer], store: store, userID: "user", initialSyncCompleted: true)
        let widgetRow = try await store.read(table: "skills", id: widget.id)
        let deleted = try await store.read(table: "skills", id: ordinary.id)
        XCTAssertEqual(widgetRow?.values["enabled"], .integer(0))
        XCTAssertEqual(deleted?.values["instruction"], .null)
        XCTAssertNotNil(deleted?.values["deleted_at"]?.text)
    }

    func testSkillEditsPreservePinAndRemovalScrubsContent() async throws {
        let store = try await makeStore()
        let library = SkillLibrary(store: store, userID: "user", defaults: [])
        var skill = NativeSkill(name: "review", label: "Review", instruction: "Read carefully")
        try await library.save(skill)
        try await library.togglePin(skill)
        skill.instruction = "Check evidence"
        try await library.save(skill)
        let edited = try await store.read(table: "skills", id: skill.id)
        XCTAssertEqual(edited?.values["pinned_order"], .integer(0))
        try await library.setEnabled(skill, value: false)
        let disabled = try await store.read(table: "skills", id: skill.id)
        XCTAssertEqual(disabled?.values["pinned_order"], .null)
        try await library.delete(skill)
        let deleted = try await store.read(table: "skills", id: skill.id)
        XCTAssertEqual(deleted?.values["instruction"], .null)
        XCTAssertNotNil(deleted?.values["deleted_at"]?.text)
    }

    func testSlashTokensMatchCanonicalBoundaries() {
        XCTAssertEqual(SkillLibrary.tokens(in: "/search /search\n/research path/review https://a/review /bad, /ok-name"), ["search", "research", "ok-name"])
        XCTAssertFalse(SkillLibrary.validName("two--words"))
        XCTAssertFalse(SkillLibrary.validName("Ünicode"))
        XCTAssertTrue(SkillLibrary.validName("review-2"))
    }

    func testPinReorderingKeepsWidgetRelativePositionsAndRejectsStaleSets() async throws {
        let store = try await makeStore()
        let defaults = try NativeLibraryDefaults.load()
        let widget = try XCTUnwrap(defaults.first { $0.table == "skills" }?.rows.first { !$0.frozenColumns.isEmpty })
        let ids = ["pin-a", "pin-b", widget.id, "pin-c"]
        for (index, id) in ids.enumerated() {
            try await store.write(table: "skills", id: id, values: [
                "user_id": .text("user"), "name": .text(id), "enabled": .integer(1),
                "pinned_order": .integer(Int64(index)),
            ])
        }
        let library = SkillLibrary(store: store, userID: "user", defaults: defaults)
        try await library.reorderPins(["pin-b", "pin-a", widget.id, "pin-c"])
        let moved = try await store.read(table: "skills", id: "pin-b")
        XCTAssertEqual(moved?.values["pinned_order"], .integer(0))
        do {
            try await library.reorderPins(["pin-c", "pin-a", widget.id, "pin-b"])
            XCTFail("Crossing a locked widget must fail")
        } catch { guard case NativeSkillError.lockedWidget = error else { throw error } }
        do {
            try await library.reorderPins(["pin-b", "pin-a", widget.id])
            XCTFail("A stale pin set must fail")
        } catch { guard case NativeSkillError.pinOrderChanged = error else { throw error } }
        let unchanged = try await store.read(table: "skills", id: "pin-c")
        XCTAssertEqual(unchanged?.values["pinned_order"], .integer(3))
    }

    private func makeStore() async throws -> NativeSyncStore {
        let keys = DeviceDataKeys()
        try await keys.publish(["0": Data(repeating: 19, count: 32)], primary: "0")
        return NativeSyncStore(database: PowerSyncDatabase(schema: NativePowerSyncSchema.schema, dbFilename: ":memory:"),
            ownerID: "user", codec: ThunderboltColumnCodec(keys: keys), trustedDevice: { await keys.isTrusted() })
    }
}
