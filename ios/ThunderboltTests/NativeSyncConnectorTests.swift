// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import XCTest
@testable import Thunderbolt

final class NativeSyncConnectorTests: XCTestCase {
    func testTokenSubjectRejectsMalformedOrMissingAccountClaims() {
        let payload = Data(#"{"sub":"account-1"}"#.utf8).base64EncodedString()
            .replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        XCTAssertEqual(NativePowerSyncHTTPTransport.tokenSubject("header.\(payload).signature"), "account-1")
        XCTAssertNil(NativePowerSyncHTTPTransport.tokenSubject("not-a-token"))
        XCTAssertNil(NativePowerSyncHTTPTransport.tokenSubject("header.e30.signature"))
        XCTAssertNil(NativePowerSyncHTTPTransport.tokenSubject("header.%%%%.signature"))
    }

    func testPowerSyncEndpointRequiresHTTPSOrLoopbackHTTP() {
        XCTAssertTrue(NativePowerSyncHTTPTransport.isSecurePowerSyncEndpoint("https://sync.example.com"))
        XCTAssertTrue(NativePowerSyncHTTPTransport.isSecurePowerSyncEndpoint("http://localhost:18082"))
        XCTAssertTrue(NativePowerSyncHTTPTransport.isSecurePowerSyncEndpoint("http://127.0.0.2:8080"))
        XCTAssertTrue(NativePowerSyncHTTPTransport.isSecurePowerSyncEndpoint("http://[::1]:8080"))

        XCTAssertFalse(NativePowerSyncHTTPTransport.isSecurePowerSyncEndpoint("http://sync.example.com"))
        XCTAssertFalse(NativePowerSyncHTTPTransport.isSecurePowerSyncEndpoint("http://localhost.example.com"))
        XCTAssertFalse(NativePowerSyncHTTPTransport.isSecurePowerSyncEndpoint("https://user:secret@sync.example.com"))
        XCTAssertFalse(NativePowerSyncHTTPTransport.isSecurePowerSyncEndpoint("file:///private/tmp/sync"))
        XCTAssertFalse(NativePowerSyncHTTPTransport.isSecurePowerSyncEndpoint("not a URL"))
    }
}
