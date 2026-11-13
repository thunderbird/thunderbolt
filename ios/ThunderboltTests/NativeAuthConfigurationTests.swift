/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
import CryptoKit
@testable import Thunderbolt

final class NativeAuthConfigurationTests: XCTestCase {
    func testConsumerConfigGatesPasskeyByServerFlagAndUsesOperatorBrand() throws {
        let config = try JSONDecoder().decode(NativeAuthConfiguration.self, from: Data(#"{"authMode":"consumer","authAllowAnonymous":true,"captchaProvider":"none","passkeyEnabled":true,"passkeyRpId":"app.thunderbolt.io","minimalMode":true,"builtInAgentEnabled":true,"allowCustomAgents":false,"branding":{"appName":"Example Org"}}"#.utf8))

        XCTAssertTrue(config.supportsEmailOTP)
        XCTAssertTrue(config.supportsPasskey)
        XCTAssertFalse(config.usesSSO)
        XCTAssertTrue(config.supportsAnonymousSignIn)
        XCTAssertTrue(config.minimalMode == true)
        XCTAssertTrue(config.supportsBuiltInAgent)
        XCTAssertEqual(config.allowCustomAgents, false)
        XCTAssertEqual(config.appName, "Example Org")
    }

    func testAnonymousUserFieldDecodesAndMissingFieldDefaultsToNil() throws {
        let anonymous = try JSONDecoder().decode(CloudUser.self, from: Data(#"{"id":"visitor-1","name":"Visitor","email":"","isAnonymous":true}"#.utf8))
        let regular = try JSONDecoder().decode(CloudUser.self, from: Data(#"{"id":"user-1","name":"User","email":"user@example.test"}"#.utf8))

        XCTAssertEqual(anonymous.isAnonymous, true)
        XCTAssertNil(regular.isAnonymous)
    }

    func testSSOAndUnknownModesNeverOfferConsumerSignIn() throws {
        let sso = try JSONDecoder().decode(NativeAuthConfiguration.self, from: Data(#"{"authMode":"saml","passkeyEnabled":true}"#.utf8))
        let unknown = try JSONDecoder().decode(NativeAuthConfiguration.self, from: Data(#"{"authMode":"future-mode"}"#.utf8))

        XCTAssertTrue(sso.usesSSO)
        XCTAssertFalse(sso.supportsEmailOTP)
        XCTAssertFalse(sso.supportsPasskey)
        XCTAssertFalse(unknown.usesSSO)
        XCTAssertFalse(unknown.supportsEmailOTP)
        XCTAssertEqual(unknown.appName, "Thunderbolt")
    }

    func testPasskeysAreHiddenWhenSelfHostedRelyingPartyIsNotAssociatedWithTheApp() throws {
        let config = try JSONDecoder().decode(NativeAuthConfiguration.self, from: Data(#"{"authMode":"consumer","passkeyEnabled":true,"passkeyRpId":"auth.example.test"}"#.utf8))

        XCTAssertTrue(config.supportsEmailOTP)
        XCTAssertFalse(config.supportsPasskey)
    }

    func testMissingConfigFailsClosedForSignInMethods() {
        let config = NativeAuthConfiguration(
            authMode: nil, authAllowAnonymous: nil, captchaProvider: nil,
            passkeyEnabled: nil, passkeyRpId: nil, minimalMode: nil,
            builtInAgentEnabled: nil, allowCustomAgents: nil, branding: nil
        )

        XCTAssertFalse(config.supportsEmailOTP)
        XCTAssertFalse(config.supportsPasskey)
        XCTAssertFalse(config.supportsAnonymousSignIn)
    }

    func testNativeALTCHAUsesTheV1SaltPlusCounterHash() throws {
        let digest = SHA256.hash(data: Data("salt0".utf8)).map { String(format: "%02x", $0) }.joined()
        let challenge = NativeALTCHAChallenge(algorithm: "SHA-256", challenge: digest, maxnumber: 2, salt: "salt", signature: "server-signature")

        XCTAssertEqual(try NativeALTCHA.solve(challenge), 0)
    }
}
