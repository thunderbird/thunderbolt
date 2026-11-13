/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import XCTest
@testable import Thunderbolt

final class NativePasskeyTests: XCTestCase {
    func testPasskeyKeyDerivationMatchesTypeScriptGoldenVector() throws {
        let prfOutput = Data((0..<32).map(UInt8.init))
        let keys = try ThunderboltPasskeyCrypto.deriveDeviceKeys(prfOutput: prfOutput)

        XCTAssertEqual(
            try keys.ecdhPublicKeyBase64,
            "BHMjjrP0AoKrGAJDP4KlIULXXUIfK2KxfurxoR17BNPxDPliZnN90mVH0coj1Awx6q8GMPsvtw1yMU2H04Mog5M="
        )
        XCTAssertEqual(
            keys.mlkemPublicKeyBase64,
            "VPxNX9GOaziWuyksxakAKxhOe/tRBqBRV6V5NgBX/WSO4aQw1zmcO9qevktj9MmWYWFJ1wKsnmRF7LevXqe7EGQzEFOyAaYhU4d80HWLqoQue0RKV/CmxAOSHdVrlLh50xYzjWbNIGNLeiSy8BInv+Yz25gMaHM1wtAzg2qhC6tj1NICoRsBUHtJt0GTXwCXOVxwqQkl83EwIZm+lBCi0bpJmoBO3WADWNs0LSd+nvJRlRzOupCYH1dOIxOSi2rLABUweDZuqtdfiTnBbMCubNu4neYsNyzD2OiDxbij6tMWyFxE2Pp7e7UuUvG1EQYt1iihkkonValexBy4OPhWGExg0rBgOHm9URvI21d8QZwvPPmF9FMndKhiLYc1mRSUApSZOBYkgOcO3HxmNfwWbhFX1ph4+coagnRyW+fDcjaEkNCNBng2oMrCtPZTZ9ZpPWcRmyV6V4XHfMSESYJECPybNxNsyBso1BKgO/W3v+eGyHkcktqZrxtIhnpjEJwMVxKo7ZIlPrAmkDI5YfGyCHg9WZqzD4FzURIlzaMChhrChZsWGqOr0my1/BzDBvlL4ZZ1VREvrwxi+nQjT4lTXHYI55Mv8PqBgPqx0FmHZsFdskWoQNXD6RE9Ikqg2qyHVPZi3NKIhUMwEKQwVXoZL9UF4+luCaSiyibHQFRtIrGnWkW8PDZa5mQ9VzUAhIDDTPM7FpiYy3V0IuqQQ5d0naqfoKw+Pnezt9M0AmOLWOlMAHnOQhCVkgKP/te9YHwX5rqP9bAfnhw2wmyP/IIazMF/inY/w6oUBxW9/8R14elgE/x+lcqib6WOqliqUUgowADF/OJahmxAXWAfCcerDQNZKLbPfjp9dPeo11qYJbsMNqAtj7iYbDl/FjWkndytZ8Unc7pqhMAqipajDCCcf6s/mswpKWGLzLRFkOst0Ie3rqNvsBOHL6WkSstWqtEST1XOQ9gy3pd+3QRkWJyWWCN0r4jFu6RvkHeXA7LLeOVyePFbtPLD+iUfwoeoX8WM6Ms8rXiPBearape0dCpvkdmSivGfsPumw7Mhr2yxZyOxwPYklSUiKTrEpqqYl3OJZscsjbiDCMxbnBZ+4GUSTJqyHviRGfQiLEq45Zu4oHZl0BiagosEekyJWaMmAPrLyox5ynavPivGcVJDSsGjdrSUjuFuQZNY6mqxKFXPMYE9cgxE3rePt7gJ44FiH/IoMeCP03w3lcVbMBsH8Qo4g+Sz7/lgT1KBzQQJwZBwTfrKVnYoCoMAnBh5oIpPCyA1nPbClVy1bVau10sC8gx8aZgKLVhi0QGygqp8c6c6abkREtbJiUZs0ZiEteZNh0BmhHHBhtKE+Mwuq5CGPfy5oDCVg6i2oAqipwon4xau/+BjCgV/VECpSMh1ugF6IfYU9caHRWfAXru3C6xu+XI0/Qih+bGOw1CXyupO4KwIwUpPPjsUWYlZuimRXJER7mJ1htupP3e/57YMDNStxtM8UFa+JiiqNRxqLxCHSdt/e4FtBkdTspwgk5vOQWWy+wRNMiGr8sxe3tDusz+VQZclkmNEj8pNUjR8Og/6sbMo1l0="
        )
    }

    func testPasskeyKeyDerivationRejectsNonWebAuthnPRFOutputLengths() {
        XCTAssertThrowsError(try ThunderboltPasskeyCrypto.deriveDeviceKeys(prfOutput: Data(repeating: 7, count: 31)))
        XCTAssertThrowsError(try ThunderboltPasskeyCrypto.deriveDeviceKeys(prfOutput: Data(repeating: 7, count: 33)))
    }

    func testBase64URLCredentialEncodingRoundTripsWithoutPadding() throws {
        let bytes = Data([0xfb, 0xff, 0x00, 0x01])
        let encoded = PasskeyWire.encodeBase64URL(bytes)

        XCTAssertEqual(encoded, "-_8AAQ")
        XCTAssertEqual(try PasskeyWire.decodeBase64URL(encoded), bytes)
    }

    func testMalformedBase64URLCredentialIsRejected() {
        XCTAssertThrowsError(try PasskeyWire.decodeBase64URL("%%%"))
    }
}
