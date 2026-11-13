/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class ManagedTinfoilProviderTests: XCTestCase {
    func testRelayURLAppendsManagedRouteToVersionedBackendPath() throws {
        XCTAssertEqual(
            try ManagedTinfoilProvider.relayURL(for: URL(string: "https://api.example.test/v1")!),
            URL(string: "https://api.example.test/v1/tinfoil")!
        )
    }

    func testRelayURLAllowsLoopbackHTTPForLocalDevelopment() throws {
        XCTAssertEqual(
            try ManagedTinfoilProvider.relayURL(for: URL(string: "http://localhost:18080/v1/")!),
            URL(string: "http://localhost:18080/v1/tinfoil")!
        )
    }

    func testRelayURLRejectsInsecureRemoteAndAmbiguousURLs() {
        for address in [
            "http://api.example.test/v1",
            "https://user:secret@api.example.test/v1",
            "https://api.example.test/v1?next=elsewhere",
            "https://api.example.test/v1#fragment"
        ] {
            XCTAssertThrowsError(try ManagedTinfoilProvider.relayURL(for: URL(string: address)!))
        }
    }
}
