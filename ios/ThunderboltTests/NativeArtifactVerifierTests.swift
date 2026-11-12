/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

@MainActor
final class NativeArtifactVerifierTests: XCTestCase {
    func testStaticCheckerRejectsBrokenScriptsAndExternalResources() async throws {
        let syntax = try await NativeArtifactVerifier.verify("<p>Hello</p><script>const = ;</script>")
        XCTAssertEqual(syntax["ok"], .bool(false))
        XCTAssertTrue(String(describing: syntax).contains("Invalid JS"))
        let remote = try await NativeArtifactVerifier.verify("<script src='https://example.com/app.js'></script>")
        XCTAssertEqual(remote["ok"], .bool(false))
        XCTAssertTrue(String(describing: remote).contains("External resources"))
    }

    func testRuntimeChecksWorkingPageAndUncaughtErrors() async throws {
        let good = try await NativeArtifactVerifier.verify("<button id='add'>Add</button><script>document.getElementById('add').onclick = () => document.body.append('added');</script>")
        XCTAssertEqual(good["ok"], .bool(true), String(describing: good))
        let bad = try await NativeArtifactVerifier.verify("<p>Hello</p><script>throw new Error('native-artifact-failure')</script>")
        XCTAssertEqual(bad["ok"], .bool(false), String(describing: bad))
        XCTAssertTrue(String(describing: bad).contains("native-artifact-failure"), String(describing: bad))
    }
}
