/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class NativeReasoningTests: XCTestCase {
    func testTinfoilRequiresExplicitReasoningAndNativeSupportedEfforts() throws {
        let catalog = try NativeReasoningCatalog.parse(Data(#"{"data":[{"id":"native","reasoning":true,"supported_efforts":["high","low","future"]},{"id":"presets","reasoning":true,"reasoning_presets":{"high":{}}},{"id":"disabled","reasoning":false,"supported_efforts":["high"]}]}"#.utf8), provider: "tinfoil")
        XCTAssertEqual(catalog["native"]?.efforts, ["low", "high"])
        XCTAssertEqual(catalog["presets"]?.efforts, [])
        XCTAssertEqual(catalog["disabled"]?.efforts, [])
        XCTAssertThrowsError(try NativeReasoningCatalog.parse(Data(#"{"data":[{"id":"bad","reasoning":"true"}]}"#.utf8), provider: "tinfoil"))
    }

    func testOpenRouterDistinguishesMissingAndNullAndMandatory() throws {
        let catalog = try NativeReasoningCatalog.parse(Data(#"{"data":[{"id":"missing"},{"id":"all","reasoning":{"supported_efforts":null}},{"id":"mandatory","reasoning":{"supported_efforts":null,"mandatory":true}},{"id":"limited","reasoning":{"supported_efforts":["none","high"]}}]}"#.utf8), provider: "openrouter")
        XCTAssertEqual(catalog["missing"]?.efforts, [])
        XCTAssertEqual(catalog["all"]?.efforts, NativeReasoningCapabilities.orderedEfforts)
        XCTAssertEqual(catalog["mandatory"]?.efforts, NativeReasoningCapabilities.orderedEfforts.filter { $0 != "none" })
        XCTAssertEqual(catalog["limited"]?.efforts, ["none", "high"])
    }

    func testExactProfileIsPreservedUntilExplicitOverride() {
        let capabilities = NativeReasoningCapabilities(efforts: ["none", "low", "high"])
        let profile = NativeReasoningResolution(capabilities: capabilities, preference: nil, requestEffort: nil,
            profileEffort: nil, profileConfigured: true, preferredEffort: nil, thinkingLevel: "high")
        XCTAssertNil(profile.requestEffort)
        let override = NativeReasoningResolution(capabilities: capabilities, preference: "none", requestEffort: "none",
            profileEffort: "high", profileConfigured: true, preferredEffort: "none", thinkingLevel: "off")
        XCTAssertEqual(override.requestEffort, "none")
        XCTAssertEqual(override.thinkingLevel, "off")
    }
}
