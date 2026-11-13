/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class NativeAccountAccessTests: XCTestCase {
    func testDeletionAndRevocationOutrankOrdinaryAuthorizationErrors() {
        XCTAssertEqual(NativeAccountAccess.decode(status: 410, data: Data()), .accountDeleted)
        XCTAssertEqual(NativeAccountAccess.decode(status: 403, data: Data(#"{"code":"DEVICE_DISCONNECTED"}"#.utf8)), .deviceRevoked)
        XCTAssertNil(NativeAccountAccess.decode(status: 403, data: Data(#"{"error":"not allowed"}"#.utf8)))
        XCTAssertEqual(NativeAccountAccess.decode(status: 401, data: Data()), .sessionExpired)
        XCTAssertFalse(NativeAccountAccess.sessionExpired.requiresErase)
        XCTAssertFalse(NativeAccountAccess.syncNotPermitted.requiresErase)
        XCTAssertTrue(NativeAccountAccess.deviceRevoked.requiresErase)
    }

    func testColdDatabaseAndAnotherAccountDoNotTriggerDeletion() {
        var monitor = NativeDeviceAccessMonitor()
        XCTAssertNil(monitor.observe([], deviceID: "d", userID: "u"))
        XCTAssertNil(monitor.observe([row(userID: "another")], deviceID: "d", userID: "u"))
        XCTAssertNil(monitor.observe([], deviceID: "d", userID: "u"))
        XCTAssertNil(monitor.observe([row()], deviceID: "d", userID: "u"))
        XCTAssertEqual(monitor.observe([], deviceID: "d", userID: "u"), .accountDeleted)
    }

    func testExplicitNullIsNotRevokedButTimestampIs() {
        var monitor = NativeDeviceAccessMonitor()
        XCTAssertNil(monitor.observe([row()], deviceID: "d", userID: "u"))
        XCTAssertEqual(monitor.observe([row(revokedAt: .text("2026-01-01T00:00:00Z"))], deviceID: "d", userID: "u"), .deviceRevoked)
    }

    private func row(userID: String = "u", revokedAt: NativeSyncValue = .null) -> NativeSyncRow {
        NativeSyncRow(table: "devices", id: "d", values: ["user_id": .text(userID), "revoked_at": revokedAt])
    }
}
