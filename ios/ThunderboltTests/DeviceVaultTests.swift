/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

@MainActor
final class DeviceVaultTests: XCTestCase {
    private struct Keys: Codable, Equatable {
        var deviceID: String
        var secret: Data
        var epoch: Int
    }

    func testAtomicRecordIsIsolatedByServerAndAccountAndUpdatesInPlace() throws {
        let vault = DeviceVault(service: "net.thunderbird.thunderbolt.native.test.\(UUID())")
        defer { try? vault.remove(server: "https://one.test/v1", userID: "user-1") }
        let keys = Keys(deviceID: "device-1", secret: Data(repeating: 7, count: 32), epoch: 1)
        try vault.save(keys, server: "https://one.test/v1", userID: "user-1")
        XCTAssertEqual(try vault.load(Keys.self, server: "https://one.test/v1", userID: "user-1"), keys)
        XCTAssertNil(try vault.load(Keys.self, server: "https://two.test/v1", userID: "user-1"))
        XCTAssertNil(try vault.load(Keys.self, server: "https://one.test/v1", userID: "user-2"))
        var rotated = keys
        rotated.epoch = 2
        rotated.secret = Data(repeating: 8, count: 32)
        try vault.save(rotated, server: "https://one.test/v1", userID: "user-1")
        XCTAssertEqual(try vault.load(Keys.self, server: "https://one.test/v1", userID: "user-1"), rotated)
        try vault.remove(server: "https://one.test/v1", userID: "user-1")
        XCTAssertNil(try vault.load(Keys.self, server: "https://one.test/v1", userID: "user-1"))
    }

    func testMalformedStoredRecordSurfacesInsteadOfReplacingDeviceKeys() throws {
        let vault = DeviceVault(service: "net.thunderbird.thunderbolt.native.test.\(UUID())")
        defer { try? vault.remove(server: "https://one.test/v1", userID: "user") }
        try vault.save(["unrecognized": "record"], server: "https://one.test/v1", userID: "user")
        XCTAssertThrowsError(try vault.load(Keys.self, server: "https://one.test/v1", userID: "user"))
    }
}
