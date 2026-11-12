/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest

@MainActor
final class NativePreferencesTasksUITests: XCTestCase {
    func testEncryptedPreferencesAndTasks() throws {
        guard let server = ProcessInfo.processInfo.environment["THUNDERBOLT_UI_SYNC_SERVER"], !server.isEmpty else {
            throw XCTSkip("This flow requires the isolated PowerSync test stack.")
        }
        XCTAssertTrue(server.hasPrefix("http://localhost:"))
        continueAfterFailure = false

        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launchEnvironment["THUNDERBOLT_SERVER_URL"] = server
        app.launchEnvironment["THUNDERBOLT_UI_TESTING"] = "1"
        app.launchEnvironment["THUNDERBOLT_RESET_SESSION"] = "1"
        app.launch()

        let email = app.textFields["signInEmail"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap()
        email.typeText("native-ui-preferences-\(UUID().uuidString.lowercased())@thunderbolt.io")
        app.buttons["sendCode"].tap()
        let code = app.textFields["signInCode"]
        XCTAssertTrue(code.waitForExistence(timeout: 10))
        code.tap()
        code.typeText("12345678")
        app.buttons["verifyCode"].tap()
        finishNativeOnboarding(in: app)
        openSidebar(in: app)
        app.buttons["openSettings"].tap()

        app.buttons["openPreferencesSettings"].tap()
        XCTAssertTrue(app.staticTexts["Preferences"].waitForExistence(timeout: 5))
        let preferredName = app.textFields["preferredName"]
        XCTAssertTrue(preferredName.waitForExistence(timeout: 5))
        preferredName.tap()
        preferredName.typeText("Native Test User")
        preferredName.typeText("\n")
        XCTAssertTrue(app.staticTexts["preferencesSaved"].waitForExistence(timeout: 5))
        let tasksFeature = app.switches["experimentalTasks"]
        XCTAssertTrue(tasksFeature.waitForExistence(timeout: 5))
        for _ in 0..<4 where !tasksFeature.isHittable { app.scrollViews.firstMatch.swipeUp() }
        if tasksFeature.value as? String != "1" { tasksFeature.tap() }

        app.buttons["openHistory"].tap()
        let openTasks = app.buttons["openTasks"]
        XCTAssertTrue(openTasks.waitForExistence(timeout: 5))
        openTasks.tap()
        XCTAssertTrue(app.staticTexts["Tasks"].waitForExistence(timeout: 5))

        let firstTask = "Native task \(UUID().uuidString.prefix(8))"
        app.buttons["newTask"].tap()
        let newTaskText = app.textFields["newTaskText"]
        XCTAssertTrue(newTaskText.waitForExistence(timeout: 5))
        newTaskText.tap()
        newTaskText.typeText(firstTask)
        app.buttons["saveNewTask"].tap()
        let taskRow = app.buttons.matching(NSPredicate(format: "label == %@ AND identifier BEGINSWITH %@", firstTask, "editTask-")).firstMatch
        XCTAssertTrue(taskRow.waitForExistence(timeout: 10))
        taskRow.swipeLeft()
        app.buttons["Delete"].tap()
        XCTAssertFalse(taskRow.waitForExistence(timeout: 5))

        let secondTask = "Native task to complete \(UUID().uuidString.prefix(8))"
        app.buttons["newTask"].tap()
        let secondTaskText = app.textFields["newTaskText"]
        XCTAssertTrue(secondTaskText.waitForExistence(timeout: 5))
        secondTaskText.tap()
        secondTaskText.typeText(secondTask)
        app.buttons["saveNewTask"].tap()
        let secondTaskRow = app.buttons.matching(NSPredicate(format: "label == %@ AND identifier BEGINSWITH %@", secondTask, "editTask-")).firstMatch
        XCTAssertTrue(secondTaskRow.waitForExistence(timeout: 10))
        let complete = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Complete \(secondTask)" )).firstMatch
        XCTAssertTrue(complete.waitForExistence(timeout: 5))
        complete.tap()
        XCTAssertFalse(secondTaskRow.waitForExistence(timeout: 5))

        app.buttons["openHistory"].tap()
        app.buttons["openSettings"].tap()
        app.buttons["openSkillsSettings"].tap()
        XCTAssertTrue(app.staticTexts["Skills"].waitForExistence(timeout: 5))
        app.buttons["newSkill"].tap()
        let slug = "ui-skill-\(UUID().uuidString.prefix(6).lowercased())"
        let skillName = app.textFields["skillLabel"]
        XCTAssertTrue(skillName.waitForExistence(timeout: 5))
        skillName.tap()
        skillName.typeText("UI Test Skill")
        let skillSlug = app.textFields["skillSlug"]
        skillSlug.tap()
        skillSlug.typeText(slug)
        let skillInstructions = app.textViews["skillInstructions"]
        skillInstructions.tap()
        skillInstructions.typeText("Initial instructions")
        app.buttons["saveSkill"].tap()

        let skillRow = app.buttons["skill-\(slug)"]
        XCTAssertTrue(skillRow.waitForExistence(timeout: 10))
        skillRow.tap()
        let editSkill = app.buttons["editSkill"]
        XCTAssertTrue(editSkill.waitForExistence(timeout: 5), "Selecting a skill should open its detail before editing")
        editSkill.tap()
        let description = app.textFields["skillDescription"]
        XCTAssertTrue(description.waitForExistence(timeout: 5))
        description.tap()
        description.typeText("Reusable notes")
        app.buttons["saveSkill"].tap()
        XCTAssertTrue(app.buttons["closeSkillDetail"].waitForExistence(timeout: 5))
        app.buttons["closeSkillDetail"].tap()
    }

    private func openSidebar(in app: XCUIApplication) {
        let toggle = app.buttons["openHistory"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        toggle.tap()
        XCTAssertTrue(app.otherElements["historySidebar"].waitForExistence(timeout: 5))
    }
}
