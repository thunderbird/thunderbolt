/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class NativeMathParserTests: XCTestCase {
    func testFindsInlineDollarAndParenthesisEquationsInOrder() {
        let tokens = NativeMathParser.tokens(#"Area is $x^2$ and circumference is \(2\pi r\)."#)

        XCTAssertEqual(tokens, [
            .text("Area is "), .equation("x^2"), .text(" and circumference is "), .equation("2\\pi r"), .text("."),
        ])
    }

    func testRecognizesDisplayMathDelimiters() {
        XCTAssertEqual(NativeMathParser.displayEquation("$$\n\\frac{1}{2}\n$$"), "\\frac{1}{2}")
        XCTAssertEqual(NativeMathParser.displayEquation("\\[x + y\\]"), "x + y")
        XCTAssertNil(NativeMathParser.displayEquation("text $$ inline $$"))
    }

    func testDoesNotTreatCurrencyOrDisplayDelimiterAsInlineMath() {
        XCTAssertEqual(NativeMathParser.tokens("That costs $5 today."), [.text("That costs $5 today.")])
        XCTAssertEqual(NativeMathParser.tokens("Use $$x + y$$"), [.text("Use $$x + y$$")])
    }
}
