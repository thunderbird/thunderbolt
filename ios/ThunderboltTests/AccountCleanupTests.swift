/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

@MainActor
final class AccountCleanupTests: XCTestCase {
    func testPreparedJournalDoesNotScheduleCleanupBeforeServerDeletionSucceeds() throws {
        let suite = "account-cleanup-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let account = DeletedAccountCleanup(server: "https://example.test/v1", userID: "u", owner: "owner", preferenceKey: "sync-u")
        let prepared = try AccountCleanup.prepare(account, in: defaults)
        XCTAssertTrue(try AccountCleanup.pending(in: defaults).isEmpty)
        AccountCleanup.commit(prepared, in: defaults)
        XCTAssertEqual(try AccountCleanup.pending(in: defaults), [account])
        defaults.set(Data("invalid journal".utf8), forKey: "pendingDeletedAccountCleanup")
        XCTAssertThrowsError(try AccountCleanup.prepare(account, in: defaults))
    }

    func testFailureStillErasesOtherStoresAndJournalSurvivesUntilSuccessfulRetry() async throws {
        let suite = "account-cleanup-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let account = DeletedAccountCleanup(server: "https://example.test/v1", userID: "u", owner: "owner", preferenceKey: "sync-u")
        try AccountCleanup.record(account, in: defaults)
        var cleared: [String] = []
        do {
            try await AccountCleanup.run([
                { cleared.append("session") },
                { throw CocoaError(.fileWriteNoPermission) },
                { cleared.append("attachments") },
                { cleared.append("keys") },
            ])
            XCTFail("A failed erase must remain retryable")
        } catch {
            XCTAssertEqual(cleared, ["session", "attachments", "keys"])
            XCTAssertEqual(try AccountCleanup.pending(in: defaults), [account])
        }
        try await AccountCleanup.run([{ cleared.append("database") }])
        try AccountCleanup.finish(account, in: defaults)
        XCTAssertTrue(try AccountCleanup.pending(in: defaults).isEmpty)
    }

    func testJournalKeepsDifferentAccountsSeparateAndDeduplicatesRetries() throws {
        let suite = "account-cleanup-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = DeletedAccountCleanup(server: "https://one.test/v1", userID: "u", owner: "one|u", preferenceKey: "one")
        let second = DeletedAccountCleanup(server: "https://two.test/v1", userID: "u", owner: "two|u", preferenceKey: "two")
        try AccountCleanup.record(first, in: defaults)
        try AccountCleanup.record(first, in: defaults)
        try AccountCleanup.record(second, in: defaults)
        try AccountCleanup.finish(first, in: defaults)
        XCTAssertEqual(try AccountCleanup.pending(in: defaults), [second])
    }
}
