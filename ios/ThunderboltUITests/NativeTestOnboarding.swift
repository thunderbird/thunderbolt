/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest

@MainActor
func finishNativeOnboarding(in app: XCUIApplication) {
    let saved = app.switches["savedRecoveryKey"]
    let ready = app.buttons["openHistory"]
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        (saved.exists && saved.isHittable) || (ready.exists && ready.isHittable)
    }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 30), .completed)
    if saved.exists {
        saved.tap()
        app.buttons["confirmRecoveryKey"].tap()
    }
    XCTAssertTrue(ready.waitForExistence(timeout: 20))
    XCTAssertTrue(ready.wait(for: \.isHittable, toEqual: true, timeout: 20))
}

@MainActor
func tapNativeSettingsControl(_ identifier: String, in app: XCUIApplication, scrollingUp: Bool = true) {
    let control = app.buttons[identifier]
    for _ in 0..<5 {
        if control.exists && control.isHittable { control.tap(); return }
        if scrollingUp { app.swipeUp() } else { app.swipeDown() }
    }
    XCTAssertTrue(control.exists && control.isHittable, "Settings control \(identifier) should be reachable by scrolling")
}
