/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

@MainActor
final class AppModelTests: XCTestCase {
    private let account = CloudSession(token: "signed.bearer", user: CloudUser(id: "user-1", name: "Chris", email: "croth@thunderbolt.io"))
    private let server = "https://example.test/v1"

    private func makeModel(client: FakeCloud, sessions: MemorySessions, chats: MemoryConversations) -> AppModel {
        AppModel(serverURL: server, defaults: UserDefaults(suiteName: UUID().uuidString)!,
                 sessionStore: sessions, conversationStore: chats, clientFactory: { _ in client })
    }

    func testOTPRequiresChallengeAndPersistsSignedBearer() async {
        let client = FakeCloud(account: account)
        let sessions = MemorySessions()
        let model = makeModel(client: client, sessions: sessions, chats: MemoryConversations())
        await model.restore()
        model.email = "  CROTH@thunderbolt.io "
        await model.sendCode()
        XCTAssertEqual(model.email, "croth@thunderbolt.io")
        XCTAssertTrue(model.challengeSent)
        model.otp = "12 345 678"
        await model.verifyCode()
        XCTAssertEqual(client.verifiedChallenge, "challenge")
        XCTAssertEqual(sessions.values[server]?.token, "signed.bearer")
        XCTAssertEqual(model.session?.user.id, account.user.id)
    }

    func testWaitlistDoesNotOfferVerificationWithoutChallenge() async {
        let client = FakeCloud(account: account)
        client.challenge = nil
        let model = makeModel(client: client, sessions: MemorySessions(), chats: MemoryConversations())
        model.email = account.user.email
        await model.sendCode()
        XCTAssertTrue(model.isWaitingForApproval)
        XCTAssertFalse(model.challengeSent)
        model.otp = "12345678"
        await model.verifyCode()
        XCTAssertNil(model.session)
        XCTAssertNil(client.verifiedChallenge)
    }

    func testFullHistoryReplayedAndSavedAcrossRelaunch() async {
        let client = FakeCloud(account: account)
        let sessions = MemorySessions(values: [server: account])
        let chats = MemoryConversations()
        let model = makeModel(client: client, sessions: sessions, chats: chats)
        await model.restore()
        model.draft = "First question"
        await model.send()
        XCTAssertEqual(model.messages.map(\.text), ["First question", "Hello there"])
        model.draft = "Follow up"
        await model.send()
        XCTAssertEqual(client.lastHistory.map(\.role), [.user, .assistant, .user])
        XCTAssertEqual(client.lastHistory.last?.text, "Follow up")
        let reopened = makeModel(client: client, sessions: sessions, chats: chats)
        await reopened.restore()
        XCTAssertEqual(reopened.messages, model.messages)
        XCTAssertEqual(reopened.currentTitle, "First question")
    }

    func testRetrySoftDeletesPartialResponseAndKeepsUserTurn() async {
        let client = FakeCloud(account: account)
        client.streamError = .interrupted
        let model = makeModel(client: client, sessions: MemorySessions(values: [server: account]), chats: MemoryConversations())
        await model.restore()
        model.draft = "Question"
        await model.send()
        XCTAssertNotNil(model.chatError)
        client.streamError = nil
        await model.retry()
        XCTAssertNil(model.chatError)
        XCTAssertEqual(model.messages.count, 2)
        XCTAssertEqual(client.lastHistory.map(\.text), ["Question"])
        XCTAssertEqual(model.conversations[0].messages.filter { $0.deletedAt != nil }.count, 1)
    }

    func testAskAnswersPersistWithoutClobberingComposerDraftAndGradedAnswersDoNotSend() async throws {
        let client = FakeCloud(account: account)
        let chats = MemoryConversations()
        let model = makeModel(client: client, sessions: MemorySessions(values: [server: account]), chats: chats)
        await model.restore()
        model.draft = "Ask a question"
        await model.send()
        let messageID = try XCTUnwrap(model.messages.last?.id)
        model.draft = "My unsent draft"
        try await model.respondToAsk(.init(messageID: messageID, storageKey: "ask/graded", prompt: "Capital?",
            mode: "single", selectedIDs: ["a"], chosenTexts: ["Paris"], matched: true, conversationalTurnText: nil))
        XCTAssertEqual(model.messages.count, 2)
        XCTAssertEqual(model.messages.last?.cache?["ask/graded"]?["matched"], .bool(true))
        try await model.respondToAsk(.init(messageID: messageID, storageKey: "ask/choice", prompt: "What next?",
            mode: "choice", selectedIDs: ["b"], chosenTexts: ["Explain"], matched: nil, conversationalTurnText: "Explain"))
        XCTAssertEqual(model.draft, "My unsent draft")
        XCTAssertEqual(model.messages.map(\.text), ["Ask a question", "Hello there", "Explain", "Hello there"])
        let reopened = makeModel(client: client, sessions: MemorySessions(values: [server: account]), chats: chats)
        await reopened.restore()
        XCTAssertEqual(reopened.messages[1].cache?["ask/choice"]?["chosen"], .array([.string("Explain")]))
    }

    func testStopCancelsStreamAndPreventsLateMutations() async {
        let client = FakeCloud(account: account)
        client.delay = .seconds(3)
        let chats = MemoryConversations()
        let model = makeModel(client: client, sessions: MemorySessions(values: [server: account]), chats: chats)
        await model.restore()
        model.draft = "Question"
        let sending = Task { await model.send() }
        while !model.isStreaming { await Task.yield() }
        await model.stop()
        await model.newChat()
        await sending.value
        XCTAssertFalse(model.isStreaming)
        XCTAssertNil(model.selectedConversationID)
        XCTAssertTrue(model.messages.isEmpty)
        XCTAssertNil(model.chatError)
        XCTAssertEqual(chats.values.values.first?.first?.messages.first?.text, "Question")
    }

    func testSwitchingChatsKeepsResponseAndDraftInTheirOwnConversation() async {
        let client = FakeCloud(account: account)
        client.delay = .milliseconds(60)
        let chats = MemoryConversations()
        let model = makeModel(client: client, sessions: MemorySessions(values: [server: account]), chats: chats)
        await model.restore()
        model.draft = "First question"
        let first = Task { await model.send() }
        while !model.isStreaming { await Task.yield() }
        let firstID = model.selectedConversationID!
        model.draft = "Unsent follow-up"
        await model.newChat()
        XCTAssertFalse(model.isStreaming)
        model.draft = "Second question"
        let second = Task { await model.send() }
        while !model.isStreaming { await Task.yield() }
        let secondID = model.selectedConversationID!
        await model.selectConversation(firstID)
        XCTAssertEqual(model.draft, "Unsent follow-up")
        await first.value
        await second.value
        XCTAssertEqual(model.messages.map(\.text), ["First question", "Hello there"])
        await model.selectConversation(secondID)
        XCTAssertEqual(model.messages.map(\.text), ["Second question", "Hello there"])
        XCTAssertFalse(model.isStreaming)
        XCTAssertEqual(chats.values.values.first?.count, 2)
    }

    func testNavigationDuringSaveStillGeneratesIntoTheOriginalConversation() async {
        let client = FakeCloud(account: account)
        let chats = MemoryConversations()
        chats.saveDelay = .milliseconds(20)
        let model = makeModel(client: client, sessions: MemorySessions(values: [server: account]), chats: chats)
        await model.restore()
        model.draft = "Persist before sending"
        let sending = Task { await model.send() }
        while !model.isSaving { await Task.yield() }
        await model.newChat()
        await sending.value
        XCTAssertNil(model.selectedConversationID)
        XCTAssertTrue(model.messages.isEmpty)
        XCTAssertEqual(model.conversations.first?.messages.map(\.text), ["Persist before sending", "Hello there"])
        XCTAssertEqual(client.lastHistory.map(\.text), ["Persist before sending"])
    }

    func testDeletionUsesScrubbedTombstonesAndAccountHistoryIsIsolated() async {
        let client = FakeCloud(account: account)
        let chats = MemoryConversations()
        let sessions = MemorySessions(values: [server: account])
        let model = makeModel(client: client, sessions: sessions, chats: chats)
        await model.restore()
        model.draft = "Private question"
        await model.send()
        let id = model.conversations[0].id
        await model.renameConversation(id, title: "Renamed")
        XCTAssertEqual(model.conversations[0].title, "Renamed")
        await model.deleteConversation(id)
        XCTAssertNotNil(model.conversations[0].deletedAt)
        XCTAssertTrue(model.conversations[0].title.isEmpty)
        XCTAssertTrue(model.conversations[0].messages.allSatisfy { $0.deletedAt != nil && $0.text.isEmpty && $0.parts == nil })
        XCTAssertEqual(chats.values.values.first?.count, 1)
        await model.signOut()
        XCTAssertNil(model.session)
        XCTAssertTrue(model.conversations.isEmpty)
        XCTAssertNil(sessions.values[server])
        let another = CloudSession(token: "another.bearer", user: CloudUser(id: "other", name: "Other", email: "other@example.test"))
        sessions.values[server] = another
        client.account = another
        await model.restore()
        XCTAssertTrue(model.conversations.isEmpty)
        XCTAssertEqual(chats.values.values.first?.first?.messages.first?.text, "")
    }

    func testExpiredSessionClearsCredentialsButRetainsDiskHistory() async {
        let client = FakeCloud(account: account)
        client.sessionExpired = true
        let sessions = MemorySessions(values: [server: account])
        let chats = MemoryConversations(values: [server + "|user-1": [Conversation(title: "Saved")]])
        let model = makeModel(client: client, sessions: sessions, chats: chats)
        await model.restore()
        XCTAssertNil(model.session)
        XCTAssertNil(sessions.values[server])
        XCTAssertTrue(model.conversations.isEmpty)
        XCTAssertEqual(chats.values[server + "|user-1"]?.count, 1)
    }

    func testSignOutKeepsTheSessionWhenServerConfirmationFails() async {
        let client = FakeCloud(account: account)
        let sessions = MemorySessions(values: [server: account])
        let model = makeModel(client: client, sessions: sessions, chats: MemoryConversations())
        await model.restore()
        client.signOutError = .http(503, "Unavailable")
        await model.signOut()
        XCTAssertEqual(model.session, account)
        XCTAssertEqual(sessions.values[server], account)
        XCTAssertNotNil(model.authError)
        client.signOutError = nil
        await model.signOut()
        XCTAssertNil(model.session)
        XCTAssertNil(sessions.values[server])
    }

    func testUnreadableHistoryIsNeverOverwrittenByANewChat() async {
        let client = FakeCloud(account: account)
        let chats = MemoryConversations()
        chats.failLoad = true
        let model = makeModel(client: client, sessions: MemorySessions(values: [server: account]), chats: chats)
        await model.restore()
        model.draft = "Do not overwrite"
        await model.send()
        XCTAssertTrue(chats.values.isEmpty)
        XCTAssertEqual(model.draft, "Do not overwrite")
    }
}

@MainActor
private final class MemorySessions: SessionStoring {
    var values: [String: CloudSession]
    init(values: [String: CloudSession] = [:]) { self.values = values }
    func load(server: String) throws -> CloudSession? { values[server] }
    func save(_ session: CloudSession?, server: String) throws { values[server] = session }
}

@MainActor
private final class MemoryConversations: ConversationStoring {
    var values: [String: [Conversation]]
    var failLoad = false
    var saveDelay: Duration = .zero
    init(values: [String: [Conversation]] = [:]) { self.values = values }
    func load(owner: String) throws -> [Conversation] {
        if failLoad { throw CocoaError(.fileReadCorruptFile) }
        return values[owner] ?? []
    }
    func save(_ conversations: [Conversation], owner: String) async throws {
        if saveDelay != .zero { try await Task.sleep(for: saveDelay) }
        values[owner] = conversations
    }
}

@MainActor
private final class FakeCloud: CloudServing {
    var account: CloudSession
    var challenge: String? = "challenge"
    var verifiedChallenge: String?
    var lastHistory: [ChatMessage] = []
    var streamError: CloudError?
    var delay: Duration = .zero
    var sessionExpired = false
    init(account: CloudSession) { self.account = account }
    func sendCode(email: String) async throws -> String? { challenge }
    func verifyCode(email: String, code: String, challenge: String) async throws -> CloudSession {
        verifiedChallenge = challenge
        return account
    }
    func restoreSession(token: String) async throws -> CloudSession? { sessionExpired ? nil : account }
    var signOutError: CloudError?
    func signOut(token: String) async throws { if let signOutError { throw signOutError } }
    func loadModels(token: String) async throws -> [ChatModel] {
        [ChatModel(id: "opus", name: "Opus", model: "opus-5-5", vendor: "anthropic", endpoint: nil)]
    }
    func stream(messages: [ChatMessage], conversationID: String, model: ChatModel, token: String,
                onEvent: @escaping @MainActor (ChatStreamEvent) -> Void) async throws {
        lastHistory = messages
        if delay != .zero { try await Task.sleep(for: delay) }
        onEvent(.text("Hello "))
        if let streamError { throw streamError }
        onEvent(.text("there"))
        onEvent(.finished)
    }
}
