/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class SandboxedArtifactDocumentTests: XCTestCase {
    func testAddsTheTauriCSPBeforeExistingPageContent() {
        let html = "<html><head><title>Report</title></head><body><h1>Ready</h1></body></html>"
        let wrapped = SandboxedArtifactDocument.wrap(html)

        XCTAssertTrue(wrapped.contains(SandboxedArtifactDocument.contentSecurityPolicy))
        XCTAssertTrue(wrapped.range(of: "Content-Security-Policy")!.lowerBound < wrapped.range(of: "<title>")!.lowerBound)
        XCTAssertTrue(wrapped.contains("<h1>Ready</h1>"))
    }

    func testWrapsHTMLFragmentsAndKeepsInlineScriptSupportUnderSourceCSP() {
        let wrapped = SandboxedArtifactDocument.wrap("<script>window.value = 1</script><p>Chart</p>")

        XCTAssertTrue(wrapped.hasPrefix("<!doctype html>"))
        XCTAssertTrue(wrapped.contains("script-src 'unsafe-inline' 'unsafe-eval'"))
        XCTAssertTrue(wrapped.contains("img-src data: blob:"))
        XCTAssertTrue(wrapped.contains("default-src 'none'"))
        XCTAssertTrue(wrapped.contains("Chart"))
    }
}
