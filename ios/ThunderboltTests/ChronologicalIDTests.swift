/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class ChronologicalIDTests: XCTestCase {
    func testRFC9562TimestampAndVersion() throws {
        let id = ChronologicalID().next(at: Date(timeIntervalSince1970: 1_645_557_742.0))
        XCTAssertTrue(id.hasPrefix("017f22e2-79b0-7"))
        XCTAssertEqual(ChronologicalID.date(from: id)?.timeIntervalSince1970, 1_645_557_742.0)
        XCTAssertNotNil(UUID(uuidString: id))
    }

    func testSameMillisecondCounterOverflowAndClockRollbackRemainOrdered() {
        let generator = ChronologicalID()
        let timestamp = Date(timeIntervalSince1970: 1_700_000_000)
        let identifiers = (0..<10_000).map { _ in generator.next(at: timestamp) }
        XCTAssertEqual(Set(identifiers).count, identifiers.count)
        XCTAssertEqual(identifiers.sorted(), identifiers)
        XCTAssertGreaterThan(generator.next(at: timestamp.addingTimeInterval(-60)), identifiers.last!)
    }

    func testNonChronologicalIDsDoNotInventDates() {
        XCTAssertNil(ChronologicalID.date(from: UUID().uuidString))
        XCTAssertNil(ChronologicalID.date(from: "tauri-opaque-id"))
    }
}
