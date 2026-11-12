/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import XCTest

@MainActor
final class ThunderboltUITests: XCTestCase {
    override func tearDown() async throws {
        if (testRun?.failureCount ?? 0) > 0 {
            attachScreenshot(of: XCUIApplication(), named: "Failure screen")
        }
        try await super.tearDown()
    }

    @MainActor
    func testEncryptedSyncSetupAndRelaunch() throws {
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
        email.typeText("native-ui-sync-\(UUID().uuidString.lowercased())@thunderbolt.io")
        app.buttons["sendCode"].tap()
        let code = app.textFields["signInCode"]
        XCTAssertTrue(code.waitForExistence(timeout: 10))
        code.tap()
        code.typeText("12345678")
        app.buttons["verifyCode"].tap()
        finishNativeOnboarding(in: app)
        app.terminate()
        app.launchEnvironment.removeValue(forKey: "THUNDERBOLT_RESET_SESSION")
        app.launch()
        XCTAssertTrue(app.buttons["openHistory"].waitForExistence(timeout: 30))
        openSidebar(in: app)
        app.buttons["accountMenu"].tap()
        app.buttons["setupSync"].tap()
        XCTAssertTrue(app.staticTexts["syncReady"].waitForExistence(timeout: 10))
        attachScreenshot(of: app, named: "Encrypted sync connected")
        app.buttons["closeSync"].tap()
        app.buttons["openSettings"].tap()
        XCTAssertTrue(app.buttons["openDevices"].waitForExistence(timeout: 5))
        app.buttons["openDevices"].tap()
        XCTAssertTrue(app.staticTexts["This device"].waitForExistence(timeout: 15))
        openSidebar(in: app)
        app.buttons["accountMenu"].tap()
        app.buttons["accountSettings"].tap()
        tapNativeSettingsControl("openSecuritySettings", in: app, scrollingUp: false)
        XCTAssertTrue(app.staticTexts["Security"].waitForExistence(timeout: 5))
        app.buttons["changeRecoveryPhrase"].tap()
        XCTAssertTrue(app.buttons["requestRecoveryChangeCode"].waitForExistence(timeout: 5))
        let recoveryStepUpLogOffset = NativeUITestSupport.backendLogOffset()
        app.buttons["requestRecoveryChangeCode"].tap()
        let recoveryStepUpCode = NativeUITestSupport.stepUpCode(after: recoveryStepUpLogOffset)
        let recoveryCode = app.textFields["recoveryChangeCode"]
        XCTAssertTrue(recoveryCode.waitForExistence(timeout: 10))
        recoveryCode.tap()
        recoveryCode.typeText(recoveryStepUpCode)
        app.buttons["replaceRecoveryPhrase"].tap()
        let updatedRecoveryPhrase = app.staticTexts["newRecoveryPhrase"]
        XCTAssertTrue(updatedRecoveryPhrase.waitForExistence(timeout: 20))
        XCTAssertEqual(updatedRecoveryPhrase.label.split(whereSeparator: \.isWhitespace).count, 24)
        app.buttons["acknowledgeNewRecoveryPhrase"].tap()
        XCTAssertTrue(app.staticTexts["Security"].waitForExistence(timeout: 5))
        app.buttons["settingsBack"].tap()
        openSidebar(in: app)
        app.buttons["showChatsSection"].tap()
        XCTAssertTrue(app.buttons["newProject"].waitForExistence(timeout: 5))
        app.buttons["newProject"].tap()
        let projectName = app.textFields["projectName"]
        XCTAssertTrue(projectName.waitForExistence(timeout: 5))
        projectName.tap()
        projectName.typeText("Native project")
        let instructions = app.textViews["projectInstructions"]
        instructions.tap()
        instructions.typeText("Use concise answers in this project.")
        app.buttons["saveProject"].tap()
        let project = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "project-", "Native project")).firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.tap()
        XCTAssertTrue(app.buttons["projectBadge"].waitForExistence(timeout: 5))
        app.buttons["projectBadge"].tap()
        XCTAssertEqual(app.textViews["projectInstructions"].value as? String, "Use concise answers in this project.")
        app.buttons["Cancel"].tap()
        app.buttons["modelPicker"].tap()
        app.buttons["Opus 5.5"].tap()
        app.buttons["modelPicker"].tap()
        XCTAssertTrue(app.sliders["reasoningEffort"].waitForExistence(timeout: 10))
        attachScreenshot(of: app, named: "Thunderbolt model and reasoning picker")
        app.buttons["Done"].tap()
        let projectComposer = app.descendants(matching: .any)["composer"]
        projectComposer.tap()
        projectComposer.typeText("Verify the native shared agent in this project.")
        app.buttons["sendMessage"].tap()
        XCTAssertTrue(app.staticTexts["Hello from the fake provider, one word at a time."].waitForExistence(timeout: 40))
        attachScreenshot(of: app, named: "Native shared agent project response")
        let contextUsage = app.buttons["contextUsage"]
        XCTAssertTrue(contextUsage.waitForExistence(timeout: 10))
        contextUsage.tap()
        XCTAssertTrue(app.buttons["compactContext"].waitForExistence(timeout: 5))
        app.buttons["compactContext"].tap()
        XCTAssertTrue(app.navigationBars["Context usage"].wait(for: \.exists, toEqual: false, timeout: 30))
        contextUsage.tap()
        app.buttons["viewContextSummary"].tap()
        XCTAssertTrue(app.navigationBars["Context summary"].waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "Native context summary")
        app.buttons["Done"].tap()
        openSidebar(in: app)
        app.buttons["accountMenu"].tap()
        app.buttons["signOut"].tap()
        XCTAssertTrue(app.textFields["signInEmail"].waitForExistence(timeout: 10))
    }

    func testEmailCodeChatHistoryPersistenceAndSignOut() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        let server = ProcessInfo.processInfo.environment["THUNDERBOLT_UI_SYNC_SERVER"] ?? "http://localhost:18080/v1"
        XCTAssertTrue(server.hasPrefix("http://localhost:"))
        app.launchEnvironment["THUNDERBOLT_SERVER_URL"] = server
        app.launchEnvironment["THUNDERBOLT_UI_TESTING"] = "1"
        app.launchEnvironment["THUNDERBOLT_RESET_SESSION"] = "1"
        app.launch()

        let emailField = app.textFields["signInEmail"]
        XCTAssertTrue(emailField.waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["currentServerLabel"].label, server)
        attachScreenshot(of: app, named: "Sign-in")
        emailField.tap()
        emailField.typeText("croth@thunderbolt.io")
        app.buttons["sendCode"].tap()

        let codeField = app.textFields["signInCode"]
        XCTAssertTrue(codeField.waitForExistence(timeout: 10))
        codeField.tap()
        codeField.typeText("00000000")
        app.buttons["verifyCode"].tap()
        XCTAssertTrue(app.staticTexts["signInError"].waitForExistence(timeout: 10))

        codeField.tap()
        codeField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8))
        codeField.typeText("12345678")
        app.buttons["verifyCode"].tap()
        finishNativeOnboarding(in: app)

        let composer = app.descendants(matching: .any)["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20))
        openSidebar(in: app)
        app.buttons["historyNewChat"].tap()
        XCTAssertTrue(app.staticTexts["emptyGreeting"].waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "Empty chat")
        let pinnedSearch = app.buttons["pinnedSkill-search"]
        XCTAssertTrue(pinnedSearch.waitForExistence(timeout: 5))
        XCTAssertLessThan(pinnedSearch.frame.maxY, composer.frame.minY)
        pinnedSearch.press(forDuration: 1)
        app.buttons["Reorder"].tap()
        XCTAssertTrue(app.navigationBars["Reorder pinned skills"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        app.buttons["modelPicker"].tap()
        app.buttons["Opus 5.5"].tap()
        app.buttons["addAttachment"].tap()
        app.buttons["chooseFiles"].tap()
        let cancelFiles = app.buttons["Cancel"]
        XCTAssertTrue(cancelFiles.waitForExistence(timeout: 5), "Attachments must open the native Files picker")
        cancelFiles.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("native iOS history check")
        app.buttons["sendMessage"].tap()

        waitForCompletedResponse(in: app)
        XCTAssertFalse(app.buttons["pinnedSkill-search"].exists, "Pinned chips are a new-chat affordance")
        let assistantReply = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "Hello from the fake provider")
        ).firstMatch
        XCTAssertTrue(assistantReply.waitForExistence(timeout: 10))
        let copyMessage = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "copyMessage-")).firstMatch
        XCTAssertTrue(copyMessage.waitForExistence(timeout: 5))
        copyMessage.tap()
        XCTAssertEqual(copyMessage.label, "Copied!")
        attachScreenshot(of: app, named: "Streamed chat")

        composer.tap()
        composer.typeText("follow-up persistence check")
        app.buttons["sendMessage"].tap()
        waitForCompletedResponse(in: app)

        openSidebar(in: app)
        app.buttons["historyNewChat"].tap()
        XCTAssertTrue(app.staticTexts["emptyGreeting"].waitForExistence(timeout: 5))
        openSidebar(in: app)
        let originalConversation = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "native iOS history check")
        ).firstMatch
        XCTAssertTrue(originalConversation.waitForExistence(timeout: 10))
        originalConversation.tap()
        XCTAssertTrue(assistantReply.waitForExistence(timeout: 10))

        app.terminate()
        app.launchEnvironment.removeValue(forKey: "THUNDERBOLT_RESET_SESSION")
        app.launch()
        XCTAssertTrue(app.buttons["openHistory"].waitForExistence(timeout: 20))
        openSidebar(in: app)
        let historySidebar = app.descendants(matching: .any)["historySidebar"]
        XCTAssertTrue(historySidebar.waitForExistence(timeout: 5))
        let screenFrame = app.windows.firstMatch.frame
        XCTAssertEqual(historySidebar.frame.minX, screenFrame.minX, accuracy: 2)
        XCTAssertLessThan(historySidebar.frame.maxX, screenFrame.maxX)
        attachScreenshot(of: app, named: "Left sidebar")
        app.buttons["searchChats"].tap()
        let historySearch = app.textFields["searchChatsField"]
        XCTAssertTrue(historySearch.waitForExistence(timeout: 5))
        historySearch.tap()
        historySearch.typeText("follow-up persistence check")
        let persistedConversation = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "native iOS history check")
        ).firstMatch
        XCTAssertTrue(persistedConversation.waitForExistence(timeout: 10))
        persistedConversation.tap()
        XCTAssertTrue(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS %@", "follow-up persistence check")
            ).firstMatch.waitForExistence(timeout: 10)
        )

        openSidebar(in: app)
        app.buttons["historyNewChat"].tap()
        composer.tap()
        composer.typeText("Render the deterministic long markdown performance fixture.")
        app.buttons["sendMessage"].tap()
        let stop = app.buttons["stopResponse"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10))
        openSidebar(in: app)
        app.buttons["historyNewChat"].tap()
        XCTAssertTrue(app.staticTexts["emptyGreeting"].waitForExistence(timeout: 5))
        XCTAssertFalse(stop.exists)
        openSidebar(in: app)
        let streamingConversation = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Render the deterministic long markdown")
        ).firstMatch
        XCTAssertTrue(streamingConversation.waitForExistence(timeout: 5))
        streamingConversation.tap()
        XCTAssertTrue(stop.waitForExistence(timeout: 5), "Switching conversations must not cancel a response")
        let copyCode = app.buttons.matching(identifier: "Copy code").firstMatch
        XCTAssertTrue(copyCode.waitForExistence(timeout: 10), "Fenced code must render a native copy action while streaming")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", "Read the measurement notes before interpreting these results.")).firstMatch.waitForExistence(timeout: 10),
            "Reference links must render their label instead of raw Markdown syntax")
        attachScreenshot(of: app, named: "Live Markdown stream")
        stop.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: stop)
        waitForExpectations(timeout: 5)
        let partialMarkdown = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Streaming section")
        ).firstMatch
        XCTAssertTrue(partialMarkdown.waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Performance stream complete."].exists)
        XCTAssertFalse(app.otherElements["chatError"].exists)
        copyCode.tap()
        XCTAssertTrue(app.buttons.matching(identifier: "Copied code").firstMatch.waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "Stopped Markdown response")

        openSidebar(in: app)
        let renameTarget = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "native iOS history check")
        ).firstMatch
        renameTarget.press(forDuration: 1)
        app.buttons["Rename"].tap()
        let renameField = app.textFields["renameChatInput"]
        XCTAssertTrue(renameField.waitForExistence(timeout: 5))
        renameField.tap()
        if let oldTitle = renameField.value as? String {
            renameField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: oldTitle.count))
        }
        renameField.typeText("Renamed native test")
        app.buttons["Save"].tap()
        let renamed = app.buttons.matching(NSPredicate(format: "label == %@", "Renamed native test")).firstMatch
        XCTAssertTrue(renamed.waitForExistence(timeout: 5))
        renamed.press(forDuration: 1)
        app.buttons["Delete"].tap()
        app.buttons["Delete chat"].tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: renamed)
        waitForExpectations(timeout: 5)
        let accountMenu = app.buttons["accountMenu"]
        XCTAssertTrue(accountMenu.waitForExistence(timeout: 5))
        accountMenu.tap()
        app.buttons["signOut"].tap()
        XCTAssertTrue(app.textFields["signInEmail"].waitForExistence(timeout: 10))
    }

    @MainActor
    func testDisposableAccountDeletionWithStepUp() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        let server = ProcessInfo.processInfo.environment["THUNDERBOLT_UI_SYNC_SERVER"] ?? "http://localhost:18080/v1"
        XCTAssertTrue(server.hasPrefix("http://localhost:"))
        app.launchEnvironment["THUNDERBOLT_SERVER_URL"] = server
        app.launchEnvironment["THUNDERBOLT_UI_TESTING"] = "1"
        app.launchEnvironment["THUNDERBOLT_RESET_SESSION"] = "1"
        app.launch()

        let email = app.textFields["signInEmail"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap()
        email.typeText("native-ui-delete-\(UUID().uuidString.lowercased())@thunderbolt.io")
        app.buttons["sendCode"].tap()

        let code = app.textFields["signInCode"]
        XCTAssertTrue(code.waitForExistence(timeout: 10))
        code.tap()
        code.typeText("12345678")
        app.buttons["verifyCode"].tap()
        finishNativeOnboarding(in: app)

        openSidebar(in: app)
        app.buttons["accountMenu"].tap()
        app.buttons["accountSettings"].tap()
        tapNativeSettingsControl("openSecuritySettings", in: app, scrollingUp: false)
        XCTAssertTrue(app.staticTexts["Security"].waitForExistence(timeout: 5))
        app.buttons["deleteAccount"].tap()
        XCTAssertTrue(app.navigationBars["Delete account"].waitForExistence(timeout: 5))
        let deletionStepUpLogOffset = NativeUITestSupport.backendLogOffset()
        app.buttons["requestAccountDeletionCode"].tap()
        let deletionStepUpCode = NativeUITestSupport.stepUpCode(after: deletionStepUpLogOffset)

        let deletionCode = app.textFields["accountDeletionCode"]
        XCTAssertTrue(deletionCode.waitForExistence(timeout: 10))
        deletionCode.tap()
        deletionCode.typeText(deletionStepUpCode)
        app.buttons["confirmAccountDeletion"].tap()
        let destructiveAction = app.buttons.matching(identifier: "confirmPermanentAccountDeletion").firstMatch
        XCTAssertTrue(destructiveAction.waitForExistence(timeout: 5))
        destructiveAction.tap()

        XCTAssertTrue(app.textFields["signInEmail"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["openHistory"].exists)
    }

    private func openSidebar(in app: XCUIApplication) {
        let toggle = app.buttons["openHistory"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertLessThan(toggle.frame.minX, 60, "The sidebar trigger must return to the left after closing")
        toggle.tap()
        XCTAssertTrue(app.otherElements["historySidebar"].waitForExistence(timeout: 5))
    }

    private func waitForCompletedResponse(in app: XCUIApplication) {
        let stopResponse = app.buttons["stopResponse"]
        XCTAssertTrue(stopResponse.waitForExistence(timeout: 10))
        expectation(
            for: NSPredicate(format: "exists == false"),
            evaluatedWith: stopResponse
        )
        waitForExpectations(timeout: 30)
    }

    private func attachScreenshot(of app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
