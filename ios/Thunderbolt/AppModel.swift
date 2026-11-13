/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Observation
import CryptoKit
import UIKit

@MainActor
@Observable
final class AppModel {
    private(set) var session: CloudSession?
    private(set) var isRestoring = true
    var email = ""
    var otp = ""
    private(set) var challengeSent = false
    private(set) var isAuthenticating = false
    private(set) var isSigningOut = false
    var authError: String?
    private(set) var authConfiguration: NativeAuthConfiguration?
    private(set) var isLoadingAuthConfiguration = false
    private(set) var isWaitingForApproval = false
    private(set) var serverURL: String
    private(set) var conversations: [Conversation] = []
    private(set) var selectedConversationID: String?
    private(set) var selectedProjectID: String?
    private(set) var projectLibrary: ProjectLibrary?
    private(set) var modelLibrary: NativeModelLibrary?
    private(set) var connectionLibrary: NativeProviderConnectionLibrary?
    private(set) var mcpLibrary: NativeMCPLibrary?
    private var pendingProviderCallback: URL?
    private(set) var skillLibrary: SkillLibrary?
    private(set) var preferences: NativePreferences?
    private(set) var tasksLibrary: TasksLibrary?
    private(set) var voicePreferences: NativeVoicePreferencesStore?
    private(set) var voiceSession: NativeVoiceSession?
    private var voiceSessionID: UUID?
    private var voiceToken: NativeSessionToken?
    var customVoiceEnabled: Bool { preferences?.values["experimental_feature_voice"] == "true" }
    var draft = ""
    private(set) var draftAttachments: [AttachmentReference] = []
    private(set) var isImportingAttachments = false
    var attachmentError: String?
    private(set) var models: [ChatModel] = []
    var selectedModelID = ""
    private(set) var isLoadingModels = false
    private(set) var reasoning: NativeReasoningResolution?
    private(set) var isSavingReasoning = false
    private(set) var reasoningError: String?
    private(set) var supportsContextCompaction = false
    let attestation = NativeTinfoilAttestationStatus()
    private(set) var isVerifyingConnection = false
    @ObservationIgnored private let reasoningCatalog = NativeReasoningCatalog()
    @ObservationIgnored private var reasoningWrite: Task<Void, Error>?
    private var isRefreshingSession = false
    var chatError: String?
    var isStreaming: Bool { selectedConversationID.map { runs[$0] != nil || compactions[$0] != nil } ?? false }
    var isCompacting: Bool { selectedConversationID.flatMap { compactions[$0] } != nil }
    var statusText: String? { isCompacting ? nativeString("Compacting context…") : selectedConversationID.flatMap { runs[$0]?.status } }
    private var pendingWrites = 0
    var isSaving: Bool { pendingWrites > 0 }
    private(set) var deviceCoordinator: DeviceCoordinator?
    private(set) var isConnectingSync = false
    private(set) var isSyncEnabled = false
    private var needsRecoveryAcknowledgement = false
    var requiresInitialSyncSetup: Bool {
        client is CloudClient && session?.user.isAnonymous != true && (!isSyncEnabled || needsRecoveryAcknowledgement)
    }
    var syncError: String?
    var syncSetupPresented = false
    private(set) var accountDevices: [NativeAccountDevice] = []
    private(set) var syncStatus: NativeSyncStatusSnapshot?
    private var isResettingLocalAccount = false

    @ObservationIgnored private var client: any CloudServing
    @ObservationIgnored private let clientFactory: @MainActor (URL) -> any CloudServing
    @ObservationIgnored private let sessionStore: any SessionStoring
    @ObservationIgnored private var conversationStore: any ConversationStoring
    @ObservationIgnored private let localConversationStore: any ConversationStoring
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var challenge = ""
    @ObservationIgnored private var lifetime = UUID()
    private var runs: [String: ChatRun] = [:]
    private var compactions: [String: ChatRun] = [:]
    private var drafts: [String: String] = [:]
    private var conversationErrors: [String: String] = [:]
    private var attachmentDrafts: [String: [AttachmentReference]] = [:]
    @ObservationIgnored let attachmentStore = AttachmentStore()
    @ObservationIgnored private var historyAvailable = true
    @ObservationIgnored private var syncStore: NativeSyncStore?
    @ObservationIgnored private var syncObserver: Task<Void, Never>?
    @ObservationIgnored private var deviceAccessObserver: Task<Void, Never>?
    @ObservationIgnored private var syncStatusObserver: Task<Void, Never>?
    @ObservationIgnored private var agentClient: NativeAgentChatClient?
    @ObservationIgnored private var serverModels: [ChatModel] = []
    @ObservationIgnored private let inferenceVault = DeviceVault(service: "net.thunderbird.thunderbolt.native.inference")

    var selectedModel: ChatModel? { models.first { $0.id == selectedModelID } }
    var selectedConfidentialConnectionKey: String? {
        guard let native = modelLibrary?.snapshot?.models.first(where: { $0.id == selectedModelID }),
              native.provider == "tinfoil" else { return nil }
        return native.isSystem == 1 ? "managed" : "user"
    }
    var isConfidentialConversation: Bool? { conversationIndex.map { conversations[$0].isPrivate == true } }
    var currentProject: NativeProject? { projectLibrary?.projects.first { $0.id == selectedProjectID } }
    private var conversationIndex: Int? { conversations.firstIndex { $0.id == selectedConversationID } }
    var messages: [ChatMessage] {
        guard let index = conversationIndex else { return [] }
        return conversations[index].messages.filter { $0.deletedAt == nil }
    }
    var currentTitle: String {
        conversationIndex.map { conversations[$0].title } ?? nativeString("New chat")
    }
    var contextSize: Int64? { conversationIndex.flatMap { conversations[$0].contextSize } }
    var contextWindow: Int64? { modelLibrary?.snapshot?.models.first { $0.id == selectedModelID }?.contextWindow }
    var contextSummary: ChatJSONValue? {
        messages.last(where: { $0.metadata?["contextCompaction"] != nil })?.metadata?["contextCompaction"]
    }
    private var owner: String? { session.map { serverURL + "|" + $0.user.id } }

    init(
        serverURL: String? = nil,
        defaults: UserDefaults = .standard,
        sessionStore: any SessionStoring = KeychainSessionStore(),
        conversationStore: any ConversationStoring = FileConversationStore(),
        clientFactory: @escaping @MainActor (URL) -> any CloudServing = { CloudClient(baseURL: $0) }
    ) {
        self.defaults = defaults
        self.sessionStore = sessionStore
        self.conversationStore = conversationStore
        self.localConversationStore = conversationStore
        self.clientFactory = clientFactory
        let candidate = serverURL ?? defaults.string(forKey: "serverURL") ?? ServerAddress.cloud
        let address = (try? ServerAddress.normalize(candidate)) ?? URL(string: ServerAddress.cloud)!
        self.serverURL = address.absoluteString
        self.client = clientFactory(address)
        configureClientLifecycle()
    }

    /// Restores a device-local session, then verifies it with the configured backend.
    func restore() async {
        let epoch = lifetime
        defer { if lifetime == epoch { isRestoring = false } }
        do {
            for account in try AccountCleanup.pending(in: defaults) {
                try await eraseLocalAccount(account)
            }
            guard let cached = try sessionStore.load(server: serverURL) else { return }
            session = cached
            email = cached.user.email
            if defaults.bool(forKey: syncPreferenceKey) { try await openLocalEncryptedHistory(session: cached) }
            await loadHistory()
            guard let refreshed = try await client.restoreSession(token: cached.token) else {
                if lifetime == epoch { await expireSession() }
                return
            }
            guard lifetime == epoch else { return }
            if refreshed.user.id != cached.user.id {
                await disconnectSync()
                conversations = []
                selectedConversationID = nil
            }
            session = refreshed
            try sessionStore.save(refreshed, server: serverURL)
            await loadHistory()
            await refreshModels()
            await enableSync()
        } catch {
            guard lifetime == epoch else { return }
            if case CloudError.http(401, _) = error { await expireSession() }
            else if session != nil { chatError = error.localizedDescription }
            else { authError = error.localizedDescription }
        }
    }

    func sendCode() async {
        guard !isAuthenticating else { return }
        if client is any NativeAuthServing, authConfiguration?.supportsEmailOTP != true { return }
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard address.contains("@"), !address.contains(" ") else {
            authError = nativeString("Enter a valid email address.")
            return
        }
        email = address
        authError = nil
        isAuthenticating = true
        let epoch = lifetime
        defer { if lifetime == epoch { isAuthenticating = false } }
        do {
            let token = try await client.sendCode(email: address)
            guard lifetime == epoch else { return }
            challenge = token ?? ""
            challengeSent = token != nil
            isWaitingForApproval = token == nil
            otp = ""
        } catch {
            if lifetime == epoch { authError = error.localizedDescription }
        }
    }

    func verifyCode() async {
        guard !isAuthenticating, challengeSent else { return }
        let code = otp.filter(\.isNumber)
        guard code.count == 8 else {
            authError = nativeString("Enter the 8-digit code from your email.")
            return
        }
        let epoch = lifetime
        authError = nil
        isAuthenticating = true
        defer { if lifetime == epoch { isAuthenticating = false } }
        do {
            let authenticated = try await client.verifyCode(email: email, code: code, challenge: challenge)
            guard lifetime == epoch else { return }
            try await acceptAuthenticatedSession(authenticated)
        } catch {
            guard lifetime == epoch else { return }
            if case CloudError.http(401, _) = error {
                authError = nativeString("That code is invalid or expired. Check your email and try again.")
            } else { authError = error.localizedDescription }
        }
    }

    func loadAuthConfiguration() async {
        guard let auth = client as? any NativeAuthServing, !isLoadingAuthConfiguration else { return }
        let epoch = lifetime
        isLoadingAuthConfiguration = true
        defer { if epoch == lifetime { isLoadingAuthConfiguration = false } }
        do {
            let configuration = try await auth.loadAuthConfiguration()
            guard epoch == lifetime else { return }
            authConfiguration = configuration
            updateModelPresentation()
            authError = nil
        } catch {
            if epoch == lifetime { authError = error.localizedDescription }
        }
    }

    func signInWithSSO() async {
        guard let auth = client as? any NativeAuthServing, authConfiguration?.usesSSO == true else { return }
        await authenticate { try await auth.signInWithSSO() }
    }

    func signInWithPasskey() async {
        guard let auth = client as? any NativeAuthServing, authConfiguration?.supportsPasskey == true else { return }
        await authenticate { try await auth.signInWithPasskey() }
    }

    func signInAnonymously() async {
        guard let auth = client as? any NativeAuthServing, authConfiguration?.supportsAnonymousSignIn == true else { return }
        await authenticate { try await auth.signInAnonymously() }
    }

    private func authenticate(_ operation: @MainActor () async throws -> CloudSession) async {
        guard !isAuthenticating else { return }
        let epoch = lifetime
        isAuthenticating = true
        authError = nil
        defer { if epoch == lifetime { isAuthenticating = false } }
        do {
            let authenticated = try await operation()
            guard epoch == lifetime else { return }
            try await acceptAuthenticatedSession(authenticated)
        } catch is CancellationError {
        } catch { if epoch == lifetime { authError = error.localizedDescription } }
    }

    private func acceptAuthenticatedSession(_ authenticated: CloudSession) async throws {
        try sessionStore.save(authenticated, server: serverURL)
        session = authenticated
        email = authenticated.user.email
        isAuthenticating = false
        backToEmail()
        await loadHistory()
        await refreshModels()
        await enableSync()
    }

    func backToEmail() {
        if isAuthenticating {
            lifetime = UUID()
            isAuthenticating = false
        }
        challengeSent = false
        isWaitingForApproval = false
        otp = ""
        challenge = ""
        authError = nil
    }

    func changeServer(_ value: String) async {
        do {
            let address = try ServerAddress.normalize(value)
            guard address.absoluteString != serverURL else { return }
            await stopAll()
            await disconnectSync()
            lifetime = UUID()
            session = nil
            conversations = []
            selectedConversationID = nil
            models = []
            selectedModelID = ""
            draft = ""
            drafts = [:]
            conversationErrors = [:]
            draftAttachments = []
            attachmentDrafts = [:]
            isImportingAttachments = false
            attachmentError = nil
            chatError = nil
            isAuthenticating = false
            isLoadingModels = false
            isRefreshingSession = false
            backToEmail()
            serverURL = address.absoluteString
            authConfiguration = nil
            isLoadingAuthConfiguration = false
            defaults.set(serverURL, forKey: "serverURL")
            client = clientFactory(address)
            configureClientLifecycle()
            isRestoring = true
            await loadAuthConfiguration()
            await restore()
        } catch { authError = error.localizedDescription }
    }

    func signOut(revokeServerSession: Bool = true) async {
        guard !isSigningOut, !isResettingLocalAccount else { return }
        isSigningOut = true
        let epoch = lifetime
        defer { isSigningOut = false }
        do {
            if let session, revokeServerSession { try await client.signOut(token: session.token) }
            guard epoch == lifetime, !isResettingLocalAccount else { return }
            try sessionStore.save(nil, server: serverURL)
            await clearSessionState()
        }
        catch {
            if lifetime == epoch {
                authError = nativeString("Could not sign out. Check your connection and try again.")
            }
        }
    }

    private func clearSessionState() async {
        await stopAll()
        await disconnectSync()
        lifetime = UUID()
        session = nil
        conversations = []
        selectedConversationID = nil
        models = []
        draft = ""
        drafts = [:]
        conversationErrors = [:]
        draftAttachments = []
        attachmentDrafts = [:]
        isImportingAttachments = false
        attachmentError = nil
        isLoadingModels = false
        isRefreshingSession = false
        chatError = nil
        backToEmail()
    }

    func refreshModels() async {
        guard let session, !isLoadingModels else { return }
        isLoadingModels = true
        let epoch = lifetime
        defer { if lifetime == epoch { isLoadingModels = false } }
        do {
            let available = try await client.loadModels(token: session.token)
            guard lifetime == epoch else { return }
            serverModels = available
            if let modelLibrary { try await modelLibrary.start(serverDefaults: (client as? CloudClient)?.modelDefaults) }
            updateModelPresentation()
            if models.isEmpty { throw CloudError.noModels }
            if historyAvailable { chatError = nil }
        } catch {
            guard lifetime == epoch else { return }
            await handleChatError(error)
        }
    }

    func reconnect() async {
        guard let cached = session, !isRestoring, !isRefreshingSession, !isConnectingSync else { return }
        isRefreshingSession = true
        let epoch = lifetime
        defer { if epoch == lifetime { isRefreshingSession = false } }
        do {
            guard let refreshed = try await client.restoreSession(token: cached.token) else {
                if epoch == lifetime { await expireSession() }
                return
            }
            guard epoch == lifetime else { return }
            guard refreshed.user.id == cached.user.id else { await expireSession(); return }
            session = refreshed
            try sessionStore.save(refreshed, server: serverURL)
            agentClient?.updateSessionToken(refreshed.token)
            voiceToken?.update(refreshed.token)
            await enableSync()
            await refreshModels()
        } catch {
            guard epoch == lifetime else { return }
            if case CloudError.http(401, _) = error { await expireSession() }
            else { syncError = error.localizedDescription }
        }
    }

    private var syncPreferenceKey: String {
        let value = SHA256.hash(data: Data((owner ?? serverURL).utf8)).map { String(format: "%02x", $0) }.joined()
        return "encryptedSync-" + value
    }

    func enableSync() async {
        guard !isConnectingSync, let session, session.user.isAnonymous != true, let owner, let cloud = client as? CloudClient else { return }
        isConnectingSync = true
        syncError = nil
        let epoch = lifetime
        defer { if epoch == lifetime { isConnectingSync = false } }
        do {
            if syncStore == nil { await stopAll() }
            let coordinator = deviceCoordinator ?? DeviceCoordinator()
            deviceCoordinator = coordinator
            try await coordinator.prepare(session: session, server: serverURL, client: cloud, deviceName: UIDevice.current.name)
            guard epoch == lifetime, coordinator.state == .ready else { return }
            let keys = coordinator.dataKeys
            let codec = ThunderboltColumnCodec(keys: keys)
            let store = syncStore ?? makeSyncStore(owner: owner, userID: session.user.id, codec: codec, keys: keys)
            let existingRepository = conversationStore as? SyncedConversationStore
            let repository = existingRepository ?? SyncedConversationStore(store: store, owner: owner, userID: session.user.id)
            if existingRepository == nil { _ = try await repository.load(owner: owner) }
            if coordinator.record?.migratedPrototype != true {
                let local = try await localConversationStore.load(owner: owner)
                let migrated = ConversationRecords.migratePrototype(local)
                // Persist the id mapping before the SQLite transaction, so retry after a crash
                // reuses the same ids instead of importing duplicate conversations.
                try await localConversationStore.save(migrated, owner: owner)
                try await repository.save(migrated, owner: owner)
                try coordinator.markPrototypeMigrated()
            }
            guard epoch == lifetime else { try await store.disconnect(); return }
            syncStore = store
            configureProjects(store: store, userID: session.user.id)
            conversationStore = repository
            // Switching the durable store is independent of network availability.
            // Relaunch must reopen this database even if connect fails below.
            defaults.set(true, forKey: syncPreferenceKey)
            if !isSyncEnabled { needsRecoveryAcknowledgement = coordinator.record?.recoveryPhrase != nil }
            isSyncEnabled = true
            if existingRepository == nil { await loadHistory() }
            guard epoch == lifetime else { return }
            try await configureModels(store: store, userID: session.user.id)
            if existingRepository == nil { try await observe(repository: repository, epoch: epoch) }
            guard let deviceID = coordinator.record?.id else { throw CryptoFailure.keyConfigurationIncomplete }
            let transport = NativePowerSyncHTTPTransport(backendURL: try ServerAddress.normalize(serverURL),
                accountID: session.user.id,
                deviceName: UIDevice.current.name,
                appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.164",
                sessionToken: { [weak self] in
                    await MainActor.run {
                        self?.lifetime == epoch && self?.session?.user.id == session.user.id ? self?.session?.token : nil
                    }
                }, deviceID: { deviceID }, onAccessInvalidation: { [weak self] reason in
                    await MainActor.run {
                        guard let self, self.lifetime == epoch else { return }
                        self.scheduleAccessInvalidation(reason)
                    }
                })
            observeAccountAccess(store: store, deviceID: deviceID, userID: session.user.id, epoch: epoch)
            _ = try await store.connect(using: NativePowerSyncConnector(store: store, transport: transport))
            guard epoch == lifetime else { try await store.disconnect(); return }
        } catch {
            if epoch == lifetime { syncError = error.localizedDescription }
        }
    }

    private func openLocalEncryptedHistory(session: CloudSession) async throws {
        guard let owner else { return }
        let epoch = lifetime
        let coordinator = DeviceCoordinator()
        guard try await coordinator.unlockLocal(server: serverURL, userID: session.user.id) else {
            historyAvailable = false
            throw CryptoFailure.keyConfigurationIncomplete
        }
        guard epoch == lifetime else { return }
        deviceCoordinator = coordinator
        (client as? CloudClient)?.deviceID = coordinator.record?.id
        let keys = coordinator.dataKeys
        let store = makeSyncStore(owner: owner, userID: session.user.id, codec: ThunderboltColumnCodec(keys: keys), keys: keys)
        let repository = SyncedConversationStore(store: store, owner: owner, userID: session.user.id)
        syncStore = store
        configureProjects(store: store, userID: session.user.id)
        conversationStore = repository
        isSyncEnabled = true
        needsRecoveryAcknowledgement = coordinator.record?.recoveryPhrase != nil
        try await configureModels(store: store, userID: session.user.id)
        try await observe(repository: repository, epoch: epoch)
        if let deviceID = coordinator.record?.id {
            observeAccountAccess(store: store, deviceID: deviceID, userID: session.user.id, epoch: epoch)
        }
    }

    private func makeSyncStore(owner: String, userID: String, codec: ThunderboltColumnCodec, keys: DeviceDataKeys) -> NativeSyncStore {
        let name = SHA256.hash(data: Data(owner.utf8)).map { String(format: "%02x", $0) }.joined()
        return NativeSyncStore.open(ownerID: userID, codec: codec,
            trustedDevice: { await keys.isTrusted() }, dbFilename: "account-\(name).sqlite")
    }

    private func configureProjects(store: NativeSyncStore, userID: String) {
        if projectLibrary == nil { projectLibrary = ProjectLibrary(store: store, userID: userID) }
        projectLibrary?.start()
    }

    private func configureModels(store: NativeSyncStore, userID: String) async throws {
        let libraryDefaults = try NativeLibraryDefaults.load()
        let library = modelLibrary ?? NativeModelLibrary(store: store, userID: userID, libraryDefaults: libraryDefaults)
        modelLibrary = library
        library.onChange = { [weak self] in self?.updateModelPresentation() }
        try await library.start(serverDefaults: (client as? CloudClient)?.modelDefaults)
        if skillLibrary == nil { skillLibrary = SkillLibrary(store: store, userID: userID, defaults: libraryDefaults) }
        skillLibrary?.start()
        if preferences == nil { preferences = NativePreferences(store: store, userID: userID) }
        preferences?.start()
        if tasksLibrary == nil { tasksLibrary = TasksLibrary(store: store, userID: userID) }
        tasksLibrary?.start()
        if voicePreferences == nil { voicePreferences = try NativeVoicePreferencesStore(server: serverURL, userID: userID) }
        if connectionLibrary == nil { connectionLibrary = NativeProviderConnectionLibrary(store: store, server: serverURL, userID: userID) }
        await connectionLibrary?.reload()
        if mcpLibrary == nil { mcpLibrary = NativeMCPLibrary(store: store, accountServer: serverURL, userID: userID) }
        await mcpLibrary?.reload()
        if let callback = pendingProviderCallback {
            pendingProviderCallback = nil
            await handleProviderCallback(callback)
        }
    }

    func handleProviderCallback(_ url: URL) async {
        guard url.scheme == "https", url.host == "app.thunderbolt.io" else { return }
        if url.path == "/mcp/oauth/callback" {
            if let mcpLibrary { _ = await mcpLibrary.handleOAuthCallback(url) }
            else { pendingProviderCallback = url }
            return
        }
        guard url.path == "/oauth/callback" else { return }
        if let connectionLibrary { _ = await connectionLibrary.handleTinfoilCallback(url) }
        else { pendingProviderCallback = url }
    }

    private func updateModelPresentation() {
        if session?.user.isAnonymous == true || authConfiguration?.supportsBuiltInAgent == false {
            models = serverModels.filter(\.usesHostedAgent)
            if !models.contains(where: { $0.id == selectedModelID }) { selectedModelID = models.first?.id ?? "" }
            return
        }
        guard let snapshot = modelLibrary?.snapshot else {
            models = serverModels
            if !models.contains(where: { $0.id == selectedModelID }) { selectedModelID = models.first?.id ?? "" }
            return
        }
        let confidential = isConfidentialConversation
        let configured = snapshot.models.filter {
            $0.isConfigured && ($0.provider != "otari" || snapshot.settings["experimental_feature_otari"] == "true") &&
                (confidential == nil || ($0.isConfidential == 1) == confidential)
        }
        models = configured.map { ChatModel(id: $0.id, name: $0.name, model: $0.model, vendor: $0.vendor, endpoint: nil) }
            + (confidential == true ? [] : serverModels.filter(\.usesHostedAgent))
        if !models.contains(where: { $0.id == selectedModelID }) {
            selectedModelID = [snapshot.selectedModelID, NativeModelDefaults.defaultModelID]
                .compactMap { $0 }.first { id in models.contains { $0.id == id } } ?? models.first?.id ?? ""
        }
    }

    func selectModel(_ id: String) async {
        guard let selected = models.first(where: { $0.id == id }), !isStreaming else { return }
        selectedModelID = id
        guard !selected.usesHostedAgent, let library = modelLibrary,
              let native = library.snapshot?.models.first(where: { $0.id == id }) else { return }
        do { try await library.repository.selectModel(id, forEncryptedThread: native.isConfidential == 1) }
        catch { chatError = error.localizedDescription }
    }

    func loadReasoning() async {
        let modelID = selectedModelID
        let epoch = lifetime
        reasoning = nil
        reasoningError = nil
        supportsContextCompaction = false
        guard let session, selectedModel?.usesHostedAgent == false, let library = modelLibrary,
              let native = library.snapshot?.models.first(where: { $0.id == modelID }) else { return }
        do {
            let configuration = try await library.repository.runtimeConfiguration(modelID: modelID,
                threadID: selectedConversationID ?? "", isEncryptedThread: native.isConfidential == 1)
            let agent = try nativeAgentClient(token: session.token)
            let supportsCompaction = try await agent.supportsCompaction(configuration: configuration)
            let resolution = try await resolveReasoning(configuration, agent: agent)
            guard epoch == lifetime, selectedModelID == modelID, !Task.isCancelled else { return }
            reasoning = resolution
            supportsContextCompaction = supportsCompaction
        } catch is CancellationError {
        } catch {
            if epoch == lifetime, selectedModelID == modelID { reasoningError = error.localizedDescription }
        }
    }

    func saveReasoning(_ effort: String) async {
        guard !isSavingReasoning, reasoning?.capabilities.efforts.contains(effort) == true,
              let library = modelLibrary else { return }
        let modelID = selectedModelID
        let epoch = lifetime
        isSavingReasoning = true
        let write = Task { try await library.repository.setReasoningEffort(effort, modelID: modelID) }
        reasoningWrite = write
        defer { if epoch == lifetime { isSavingReasoning = false; reasoningWrite = nil } }
        do {
            try await write.value
            guard epoch == lifetime else { return }
            try await library.refresh()
            if selectedModelID == modelID { await loadReasoning() }
        } catch { if epoch == lifetime { reasoningError = error.localizedDescription } }
    }

    private func nativeAgentClient(token: String) throws -> NativeAgentChatClient {
        guard let session else { throw CloudError.invalidResponse }
        if agentClient == nil {
            agentClient = try NativeAgentChatClient(serverURL: ServerAddress.normalize(serverURL), userID: session.user.id,
                sessionToken: token, deviceID: deviceCoordinator?.record?.id, cacheSecret: try inferenceCacheSecret(),
                attestation: attestation)
        }
        guard let agentClient else { throw CloudError.invalidResponse }
        agentClient.updateSessionToken(token)
        return agentClient
    }

    func verifyConfidentialConnection() async {
        guard let key = selectedConfidentialConnectionKey, let session, !isVerifyingConnection else { return }
        let epoch = lifetime
        isVerifyingConnection = true
        attestation.markVerifying(key)
        defer { if epoch == lifetime { isVerifyingConnection = false } }
        do { try await nativeAgentClient(token: session.token).verifyConfidentialConnection(userProvided: key == "user") }
        catch { if epoch == lifetime { attestation.fail(key, message: error.localizedDescription) } }
    }

    private func resolveReasoning(_ configuration: NativeModelRuntimeConfiguration, agent: NativeAgentChatClient) async throws -> NativeReasoningResolution {
        let capabilities: NativeReasoningCapabilities?
        do {
            capabilities = try await reasoningCatalog.capabilities(provider: configuration.model.provider, modelID: configuration.model.model)
        } catch {
            try Task.checkCancellation()
            // Discovery is advisory; preserve explicit saved choices during provider catalog outages.
            let saved = configuration.reasoningEffort
            let profile = try await agent.resolveReasoning(configuration: configuration,
                capabilities: NativeReasoningCapabilities(efforts: []))
            return NativeReasoningResolution(
                capabilities: NativeReasoningCapabilities(efforts: []), preference: saved, requestEffort: saved,
                profileEffort: nil, profileConfigured: configuration.profile?.providerOptionsJSON != nil,
                preferredEffort: saved, thinkingLevel: saved == "none" ? "off" : saved ?? profile.thinkingLevel
            )
        }
        return try await agent.resolveReasoning(configuration: configuration, capabilities: capabilities)
    }

    private func observe(repository: SyncedConversationStore, epoch: UUID) async throws {
        let changes = try await repository.changes()
        syncObserver?.cancel()
        syncObserver = Task { [weak self] in
            do {
                for try await stored in changes {
                    guard let self, self.lifetime == epoch else { return }
                    self.applySyncedConversations(stored)
                }
            } catch is CancellationError {
            } catch {
                if let self, self.lifetime == epoch { self.syncError = error.localizedDescription }
            }
        }
    }

    private func configureClientLifecycle() {
        guard let cloud = client as? CloudClient else { return }
        cloud.onAccessInvalidation = { [weak self, weak cloud] reason in
            guard let self, let cloud, self.client as? CloudClient === cloud else { return }
            self.scheduleAccessInvalidation(reason)
        }
    }

    private func observeAccountAccess(store: NativeSyncStore, deviceID: String, userID: String, epoch: UUID) {
        if syncStatusObserver == nil {
            syncStatusObserver = Task { [weak self] in
                for await status in await store.watchSyncStatus() {
                    guard let self, self.lifetime == epoch, !Task.isCancelled else { return }
                    self.syncStatus = status
                }
            }
        }
        guard deviceAccessObserver == nil else { return }
        deviceAccessObserver = Task { [weak self] in
            var monitor = NativeDeviceAccessMonitor()
            do {
                for try await rows in try await store.watch(table: "devices", includeDeleted: true) {
                    guard let self, self.lifetime == epoch, !Task.isCancelled else { return }
                    if let reason = monitor.observe(rows, deviceID: deviceID, userID: userID) {
                        self.scheduleAccessInvalidation(reason)
                        return
                    }
                }
            } catch is CancellationError {
            } catch { if let self, self.lifetime == epoch { self.syncError = error.localizedDescription } }
        }
    }

    private func scheduleAccessInvalidation(_ reason: NativeAccountAccess) {
        guard session != nil, !isResettingLocalAccount else { return }
        if reason.requiresErase { isResettingLocalAccount = true }
        let epoch = lifetime
        // Queue teardown outside the network/SQLite callback that detected it.
        // Draining those operations from inside their callback would deadlock.
        Task { [weak self] in
            guard let self, self.lifetime == epoch else { return }
            switch reason {
            case .sessionExpired: await self.reconnect()
            case .syncNotPermitted:
                do { try await self.syncStore?.disconnect() }
                catch { self.syncError = error.localizedDescription }
            default: await self.eraseInvalidatedAccount(reason)
            }
        }
    }

    private func eraseInvalidatedAccount(_ reason: NativeAccountAccess) async {
        defer { isResettingLocalAccount = false }
        guard let session, let owner else { return }
        let account = DeletedAccountCleanup(server: serverURL, userID: session.user.id, owner: owner, preferenceKey: syncPreferenceKey)
        var cleanupError: Error?
        do { try AccountCleanup.record(account, in: defaults) }
        catch { cleanupError = error }
        stopAccountObservers()
        await stopAll()
        do { try await eraseLocalAccount(account) }
        catch { cleanupError = error }
        await clearSessionState()
        authError = reason == .deviceRevoked
            ? nativeString("This device was disconnected from your account. Local account data has been removed.")
            : nativeString("This account is no longer available on this device. Local account data has been removed.")
        if cleanupError != nil {
            authError = nativeString("Access to this account was removed. Some local files could not be removed; cleanup will retry when you reopen the app.")
        }
    }

    private func stopAccountObservers() {
        deviceAccessObserver?.cancel()
        deviceAccessObserver = nil
        syncStatusObserver?.cancel()
        syncStatusObserver = nil
        syncStatus = nil
    }

    func recoverSync(phrase: String) async {
        guard let coordinator = deviceCoordinator, let session, let cloud = client as? CloudClient, !isConnectingSync else { return }
        isConnectingSync = true
        syncError = nil
        let epoch = lifetime
        do { try await coordinator.recoverWithPhrase(phrase: phrase, session: session, server: serverURL, client: cloud) }
        catch { if epoch == lifetime { syncError = error.localizedDescription } }
        guard epoch == lifetime else { return }
        isConnectingSync = false
        if coordinator.state == .ready { await enableSync() }
    }

    func startDeviceApproval() async {
        guard let coordinator = deviceCoordinator, let session, let cloud = client as? CloudClient else { return }
        let epoch = lifetime
        syncError = nil
        do { _ = try await coordinator.startApprovalSession(client: cloud, token: session.token) }
        catch { if epoch == lifetime { syncError = error.localizedDescription } }
    }

    func pollDeviceApproval() async {
        guard let coordinator = deviceCoordinator, let session, let cloud = client as? CloudClient else { return }
        let epoch = lifetime
        do {
            _ = try await coordinator.pollApprovalCode(client: cloud, token: session.token)
            guard epoch == lifetime else { return }
            if coordinator.state == .ready { await enableSync() }
        } catch { if epoch == lifetime { syncError = error.localizedDescription } }
    }

    func watchAccountDevices() async {
        guard let store = syncStore, let session else { return }
        let epoch = lifetime
        do {
            for try await _ in try await store.watch(table: "devices", includeDeleted: true) {
                let devices = try await store.accountDevices(ownerID: session.user.id)
                guard epoch == lifetime, !Task.isCancelled else { return }
                accountDevices = devices
            }
        } catch is CancellationError {
        } catch { if epoch == lifetime { syncError = error.localizedDescription } }
    }

    func challengeDevice(_ device: NativeAccountDevice) async throws {
        guard let coordinator = deviceCoordinator, let session, let cloud = client as? CloudClient,
              device.approvalPending, !device.trusted, device.revokedAt == nil else {
            throw DeviceTrustError.approvalChanged
        }
        _ = try await coordinator.challengePendingDevice(anchor: device.approvalAnchor(userID: session.user.id),
            client: cloud, token: session.token)
    }

    func approvalChoices(for deviceID: String) async throws -> ApprovalCodePrompt? {
        guard let coordinator = deviceCoordinator, let session, let cloud = client as? CloudClient else {
            throw DeviceTrustError.approvalChanged
        }
        return try await coordinator.pollPendingDeviceCode(deviceID: deviceID, client: cloud, token: session.token)
    }

    func approveDevice(_ deviceID: String, code: String) async throws {
        guard let coordinator = deviceCoordinator, let session, let cloud = client as? CloudClient else {
            throw DeviceTrustError.approvalChanged
        }
        try await coordinator.approvePendingDevice(deviceID: deviceID, selectedCode: code, client: cloud, token: session.token)
    }

    func acknowledgeRecoveryPhrase() {
        do {
            try deviceCoordinator?.acknowledgeRecoveryPhrase()
            if deviceCoordinator?.record?.recoveryPhrase == nil { needsRecoveryAcknowledgement = false }
        }
        catch { syncError = error.localizedDescription }
    }

    func requestRecoveryChangeCode() async throws {
        guard let coordinator = deviceCoordinator, let session, let cloud = client as? CloudClient else { throw CloudError.missingToken }
        try await coordinator.requestRecoveryPhraseChangeCode(client: cloud, token: session.token)
    }

    func replaceRecoveryPhrase(otp: String) async throws -> String {
        guard let coordinator = deviceCoordinator, let session, let cloud = client as? CloudClient else { throw CloudError.missingToken }
        return try await coordinator.changeRecoveryPhrase(stepUpOTP: otp, client: cloud, token: session.token)
    }

    func revokeDevice(id: String) async throws -> Bool {
        guard let coordinator = deviceCoordinator, let session, let cloud = client as? CloudClient else { throw CloudError.missingToken }
        return try await coordinator.revokeDevice(deviceID: id, client: cloud, token: session.token)
    }

    func finishDeviceLockout() async throws {
        guard let coordinator = deviceCoordinator, let session, let cloud = client as? CloudClient else { throw CloudError.missingToken }
        try await coordinator.finishDeviceLockout(client: cloud, token: session.token)
    }

    func requestAccountDeletionCode() async throws {
        guard let session, let cloud = client as? CloudClient else { throw CloudError.missingToken }
        try await cloud.requestAccountDeletionCode(token: session.token)
    }

    func loadPasskeys() async throws -> [NativePasskeyRecord] {
        guard let session, let cloud = client as? CloudClient else { throw CloudError.missingToken }
        return try await NativePasskeyCoordinator(client: cloud).list(session: session)
    }

    func registerPasskeyForSync() async throws {
        guard let session, let coordinator = deviceCoordinator, let cloud = client as? CloudClient else { throw CloudError.missingToken }
        try await NativePasskeyCoordinator(client: cloud).registerForSync(session: session, deviceCoordinator: coordinator, client: cloud)
    }

    func removePasskey(credentialID: String) async throws {
        guard let session, let coordinator = deviceCoordinator, let cloud = client as? CloudClient else { throw CloudError.missingToken }
        try await NativePasskeyCoordinator(client: cloud).remove(credentialID: credentialID, session: session, deviceCoordinator: coordinator, client: cloud)
    }

    func unlockSyncWithPasskey(credentialID: String) async {
        guard let session, let coordinator = deviceCoordinator, let cloud = client as? CloudClient, !isConnectingSync else { return }
        let epoch = lifetime
        isConnectingSync = true
        syncError = nil
        do {
            try await NativePasskeyCoordinator(client: cloud).unlockSync(credentialID: credentialID,
                session: session, server: serverURL, deviceCoordinator: coordinator, client: cloud)
        } catch { if epoch == lifetime { syncError = error.localizedDescription } }
        guard epoch == lifetime else { return }
        isConnectingSync = false
        if coordinator.state == .ready { await enableSync() }
    }

    func deleteAccount(otp: String) async throws {
        guard let session, let owner, let cloud = client as? CloudClient, !isResettingLocalAccount else { throw CloudError.missingToken }
        isResettingLocalAccount = true
        defer { isResettingLocalAccount = false }
        let epoch = lifetime
        let account = DeletedAccountCleanup(server: serverURL, userID: session.user.id, owner: owner, preferenceKey: syncPreferenceKey)
        let cleanupJournal = try AccountCleanup.prepare(account, in: defaults)
        await stopAll()
        try await cloud.deleteAccount(stepUpOTP: otp, token: session.token)
        AccountCleanup.commit(cleanupJournal, in: defaults)
        guard epoch == lifetime else { throw CancellationError() }
        stopAccountObservers()
        syncObserver?.cancel()
        modelLibrary?.stop()
        projectLibrary?.stop()
        skillLibrary?.stop()
        preferences?.stop()
        tasksLibrary?.stop()
        var cleanupError: Error?
        do { try await eraseLocalAccount(account) }
        catch { cleanupError = error }
        await clearSessionState()
        if let cleanupError {
            authError = nativeString("Your account was deleted. Some local files could not be removed; cleanup will retry when you reopen the app.")
            throw cleanupError
        }
    }

    private func eraseLocalAccount(_ account: DeletedAccountCleanup) async throws {
        let activeAccount = owner == account.owner
        let name = SHA256.hash(data: Data(account.owner.utf8)).map { String(format: "%02x", $0) }.joined()
        let store = activeAccount ? syncStore : nil
        let database = store ?? NativeSyncStore.open(ownerID: account.userID, codec: nil,
            trustedDevice: { false }, dbFilename: "account-\(name).sqlite")
        try await AccountCleanup.run([
            { if activeAccount { try await self.agentClient?.close() } },
            {
                if try self.sessionStore.load(server: account.server)?.user.id == account.userID {
                    try self.sessionStore.save(nil, server: account.server)
                }
            },
            { try await database.disconnectAndClear(clearLocal: true) },
            { try await self.localConversationStore.save([], owner: account.owner) },
            { try await self.attachmentStore.removeAccount(owner: account.owner) },
            { try NativeAgentWorkspaceStore.removeAccount(serverURL: ServerAddress.normalize(account.server), userID: account.userID) },
            { try DeviceVault().remove(server: account.server, userID: account.userID) },
            { try self.inferenceVault.remove(server: account.server, userID: account.userID) },
            { try DeviceVault(service: "net.thunderbird.thunderbolt.native.voice").remove(server: account.server, userID: account.userID) },
            { try DeviceVault(service: "net.thunderbird.thunderbolt.native.tinfoil.oauth").remove(server: account.server, userID: account.userID) },
            { try DeviceVault(service: "net.thunderbird.thunderbolt.native.mcp.oauth").remove(server: account.server, userID: account.userID) },
        ])
        if activeAccount { agentClient = nil }
        defaults.removeObject(forKey: account.preferenceKey)
        try AccountCleanup.finish(account, in: defaults)
    }

    private func applySyncedConversations(_ stored: [Conversation]) {
        guard pendingWrites == 0 else { return }
        do { try (conversationStore as? SyncedConversationStore)?.accept(stored) }
        catch { syncError = error.localizedDescription; return }
        var merged = stored
        for (conversationID, run) in runs {
            guard let live = conversations.first(where: { $0.id == conversationID }),
                  let reply = live.messages.first(where: { $0.id == run.replyID }) else { continue }
            guard let index = merged.firstIndex(where: { $0.id == conversationID }) else {
                merged.append(live)
                continue
            }
            if let message = merged[index].messages.firstIndex(where: { $0.id == reply.id }) {
                merged[index].messages[message] = reply
            } else { merged[index].messages.append(reply) }
        }
        conversations = merged
        if let index = conversationIndex { selectedProjectID = conversations[index].projectID }
        if let selectedConversationID, !merged.contains(where: { $0.id == selectedConversationID && $0.deletedAt == nil }) {
            self.selectedConversationID = nil
        }
    }

    private func disconnectSync() async {
        await stopVoice()
        voicePreferences = nil
        stopAccountObservers()
        do { try await agentClient?.close() }
        catch { syncError = error.localizedDescription }
        agentClient = nil
        attestation.clearAll()
        supportsContextCompaction = false
        isVerifyingConnection = false
        reasoningWrite?.cancel()
        reasoningWrite = nil
        isSavingReasoning = false
        reasoning = nil
        reasoningError = nil
        modelLibrary?.stop()
        modelLibrary = nil
        connectionLibrary?.cancelTinfoilOAuth()
        connectionLibrary = nil
        mcpLibrary?.reset()
        mcpLibrary = nil
        pendingProviderCallback = nil
        skillLibrary?.stop()
        skillLibrary = nil
        preferences?.stop()
        preferences = nil
        tasksLibrary?.stop()
        tasksLibrary = nil
        serverModels = []
        syncObserver?.cancel()
        syncObserver = nil
        if let store = syncStore {
            do { try await store.disconnect() }
            catch { syncError = error.localizedDescription }
        }
        syncStore = nil
        projectLibrary?.stop()
        projectLibrary = nil
        selectedProjectID = nil
        await deviceCoordinator?.suspend()
        deviceCoordinator = nil
        conversationStore = localConversationStore
        isSyncEnabled = false
        needsRecoveryAcknowledgement = false
        isConnectingSync = false
        accountDevices = []
    }

    func newChat(projectID: String? = nil) async {
        await stopVoice()
        drafts[selectedConversationID ?? "new"] = draft
        attachmentDrafts[selectedConversationID ?? "new"] = draftAttachments
        selectedConversationID = nil
        selectedProjectID = projectID
        draft = drafts["new"] ?? ""
        draftAttachments = attachmentDrafts["new"] ?? []
        chatError = nil
        updateModelPresentation()
    }

    func selectConversation(_ id: String) async {
        await stopVoice()
        guard conversations.contains(where: { $0.id == id && $0.deletedAt == nil }) else { return }
        drafts[selectedConversationID ?? "new"] = draft
        attachmentDrafts[selectedConversationID ?? "new"] = draftAttachments
        selectedConversationID = id
        selectedProjectID = conversations.first(where: { $0.id == id })?.projectID
        draft = drafts[id] ?? ""
        draftAttachments = attachmentDrafts[id] ?? []
        chatError = conversationErrors[id]
        updateModelPresentation()
        if let model = conversations.first(where: { $0.id == id })?.modelID,
           models.contains(where: { $0.id == model }) { selectedModelID = model }
    }

    func renameConversation(_ id: String, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let index = conversations.firstIndex(where: { $0.id == id && $0.deletedAt == nil }) else { return }
        conversations[index].title = trimmed
        await persist()
    }

    func moveConversation(_ id: String, to projectID: String?) async {
        guard let index = conversations.firstIndex(where: { $0.id == id && $0.deletedAt == nil }),
              projectID == nil || projectLibrary?.projects.contains(where: { $0.id == projectID }) == true else { return }
        conversations[index].projectID = projectID
        if id == selectedConversationID { selectedProjectID = projectID }
        await persist()
    }

    func deleteConversation(_ id: String) async {
        await stop(conversationID: id)
        if selectedConversationID == id { await newChat() }
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        let date = Date()
        conversations[index].deletedAt = date
        conversations[index].title = ""
        conversations[index].modelID = nil
        conversations[index].agentID = nil
        conversations[index].projectID = nil
        for messageIndex in conversations[index].messages.indices {
            conversations[index].messages[messageIndex].deletedAt = conversations[index].messages[messageIndex].deletedAt ?? date
            conversations[index].messages[messageIndex].text = ""
            conversations[index].messages[messageIndex].parts = nil
            conversations[index].messages[messageIndex].metadata = nil
            conversations[index].messages[messageIndex].parentID = nil
            conversations[index].messages[messageIndex].modelID = nil
        }
        drafts[id] = nil
        attachmentDrafts[id] = nil
        conversationErrors[id] = nil
        await persist()
    }

    func importAttachments(_ urls: [URL]) async {
        guard let owner, !isImportingAttachments else { return }
        guard draftAttachments.count + urls.count <= AttachmentStore.maximumCount else {
            attachmentError = AttachmentError.tooMany.localizedDescription
            return
        }
        let epoch = lifetime
        let target = selectedConversationID ?? "new"
        isImportingAttachments = true
        attachmentError = nil
        defer { if epoch == lifetime { isImportingAttachments = false } }
        for url in urls {
            do {
                let reference = try await attachmentStore.importFile(url, owner: owner)
                guard epoch == lifetime else { return }
                appendAttachment(reference, to: target)
            } catch { if epoch == lifetime { attachmentError = error.localizedDescription } }
        }
    }

    func attachmentDraftTarget() -> AttachmentDraftTarget? {
        owner.map { AttachmentDraftTarget(owner: $0, lifetime: lifetime, conversationID: selectedConversationID ?? "new") }
    }

    func importPhoto(_ bytes: Data, filename: String, mimeType: String?, target: AttachmentDraftTarget) async {
        guard let owner, !isImportingAttachments, target.owner == owner, target.lifetime == lifetime else { return }
        let count = target.conversationID == (selectedConversationID ?? "new") ? draftAttachments.count : attachmentDrafts[target.conversationID, default: []].count
        guard count < AttachmentStore.maximumCount else {
            attachmentError = AttachmentError.tooMany.localizedDescription
            return
        }
        let epoch = lifetime
        isImportingAttachments = true
        attachmentError = nil
        defer { if epoch == lifetime { isImportingAttachments = false } }
        do {
            let reference = try await attachmentStore.store(bytes, filename: filename, mimeType: mimeType, owner: owner)
            guard epoch == lifetime else { return }
            appendAttachment(reference, to: target.conversationID)
        } catch { if epoch == lifetime { attachmentError = error.localizedDescription } }
    }

    private func appendAttachment(_ reference: AttachmentReference, to target: String) {
        if target == (selectedConversationID ?? "new") { draftAttachments.append(reference) }
        else { attachmentDrafts[target, default: []].append(reference) }
    }

    func removeDraftAttachment(_ id: String) {
        draftAttachments.removeAll { $0.id == id }
    }

    func attachmentPreview(_ reference: AttachmentReference) async throws -> URL? {
        guard let owner else { return nil }
        let epoch = lifetime
        let url = try await attachmentStore.previewURL(reference, owner: owner)
        return epoch == lifetime ? url : nil
    }

    func send() async {
        _ = await sendMessage(text: draft, attachments: draftAttachments, clearComposer: true)
    }

    func startVoice() async {
        guard voiceSession == nil, !isStreaming, let session, selectedModel != nil, authConfiguration?.minimalMode != true else { return }
        let epoch = lifetime
        do {
            let store = try voicePreferences ?? NativeVoicePreferencesStore(server: serverURL, userID: session.user.id)
            voicePreferences = store
            let engine: any NativeVoiceEngine
            if customVoiceEnabled && store.preferences.provider == .openAICompatible {
                engine = try NativeOpenAICompatibleVoiceEngine(preferences: store.preferences)
            } else {
                let token = NativeSessionToken(session.token)
                voiceToken = token
                let configuration = ManagedTinfoilProviderConfiguration(backendURL: try ServerAddress.normalize(serverURL),
                    userCacheSecret: try inferenceCacheSecret(),
                    appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.164",
                    deviceID: deviceCoordinator?.record?.id, sessionToken: { token.read() })
                engine = NativeThunderboltVoiceEngine(client: ManagedTinfoilVoiceClientFactory(configuration: configuration))
            }
            if selectedConversationID == nil {
                let native = modelLibrary?.snapshot?.models.first { $0.id == selectedModelID }
                let conversation = Conversation(title: nativeString("New chat"), modelID: selectedModelID,
                    projectID: currentProject?.id, isPrivate: native?.isConfidential == 1)
                conversations.insert(conversation, at: 0)
                selectedConversationID = conversation.id
            }
            guard let conversationID = selectedConversationID else { throw CloudError.invalidResponse }
            let id = UUID()
            voiceSessionID = id
            let voice = NativeVoiceSession(conversationID: conversationID, engine: engine, reply: { [weak self] conversationID, text in
                guard let self else { throw CancellationError() }
                return try await self.voiceReply(conversationID: conversationID, text: text, sessionID: id)
            })
            voiceSession = voice
            try await voice.start()
            guard epoch == lifetime, voiceSessionID == id else { await voice.stop(); return }
        } catch { if epoch == lifetime { chatError = error.localizedDescription } }
    }

    func stopVoice() async {
        let voice = voiceSession
        voiceSessionID = nil
        voiceSession = nil
        voiceToken?.update(nil)
        voiceToken = nil
        await voice?.stop()
    }

    private func voiceReply(conversationID: String, text: String, sessionID: UUID) throws -> AsyncThrowingStream<String, Error> {
        guard voiceSessionID == sessionID, selectedConversationID == conversationID, !isStreaming else { throw CancellationError() }
        return AsyncThrowingStream { continuation in
            let task = Task { @MainActor [weak self] in
                guard let self, self.voiceSessionID == sessionID else { continuation.finish(throwing: CancellationError()); return }
                let succeeded = await self.sendMessage(text: text, onResponseText: { continuation.yield($0) })
                if succeeded { continuation.finish() }
                else { continuation.finish(throwing: CloudError.interrupted) }
            }
            continuation.onTermination = { [weak self] reason in
                guard case .cancelled = reason else { return }
                task.cancel()
                Task { @MainActor in
                    guard let self, self.voiceSessionID == sessionID || self.voiceSessionID == nil else { return }
                    await self.stop(conversationID: conversationID)
                }
            }
        }
    }

    private func inferenceCacheSecret() throws -> String {
        guard let session else { throw CloudError.missingToken }
        if let secret = try inferenceVault.load(String.self, server: serverURL, userID: session.user.id) { return secret }
        let secret = try ThunderboltCrypto.randomBytes(count: 32).base64EncodedString()
        try inferenceVault.save(secret, server: serverURL, userID: session.user.id)
        return secret
    }

    func respondToAsk(_ response: NativeAskResponse) async throws {
        guard let index = conversationIndex, let messageIndex = conversations[index].messages.firstIndex(where: { $0.id == response.messageID }),
              !isStreaming else { throw CloudError.interrupted }
        var cache = conversations[index].messages[messageIndex].cache?.objectValue ?? [:]
        cache[response.storageKey] = .object([
            "prompt": .string(response.prompt), "mode": .string(response.mode),
            "selectedIds": .array(response.selectedIDs.map(ChatJSONValue.string)),
            "chosen": .array(response.chosenTexts.map(ChatJSONValue.string)),
            "matched": response.matched.map(ChatJSONValue.bool) ?? .null,
        ])
        conversations[index].messages[messageIndex].cache = .object(cache)
        guard await persist() else { throw CocoaError(.fileWriteUnknown) }
        if let text = response.conversationalTurnText, !(await sendMessage(text: text)) { throw CloudError.interrupted }
    }

    private func sendMessage(text input: String, attachments: [AttachmentReference] = [], clearComposer: Bool = false,
                             onResponseText: (@MainActor @Sendable (String) -> Void)? = nil) async -> Bool {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!text.isEmpty || !attachments.isEmpty), !isImportingAttachments, !isStreaming, !isSaving,
              session != nil, let chosenModel = selectedModel, historyAvailable, !Task.isCancelled else { return false }
        if selectedConversationID == nil {
            let title = text.isEmpty ? attachments.first?.filename ?? nativeString("New chat") : String(text.prefix(64))
            let native = modelLibrary?.snapshot?.models.first { $0.id == selectedModelID }
            let chat = Conversation(title: title, modelID: selectedModelID, projectID: currentProject?.id,
                isPrivate: native?.isConfidential == 1)
            conversations.insert(chat, at: 0)
            selectedConversationID = chat.id
        }
        guard let index = conversationIndex else { return false }
        let targetID = conversations[index].id
        let parts = (text.isEmpty ? [] : [ChatContentPart(rawValue: .object(["type": .string("text"), "text": .string(text)]), fallbackID: "text")])
            + attachments.map(\.part)
        if conversations[index].messages.isEmpty { conversations[index].title = String(text.prefix(64)).isEmpty ? attachments.first?.filename ?? nativeString("New chat") : String(text.prefix(64)) }
        conversations[index].messages.append(ChatMessage(role: .user, text: text, parts: parts,
            parentID: messages.last?.id, modelID: selectedModelID))
        conversations[index].updatedAt = Date()
        conversations[index].modelID = selectedModelID
        if clearComposer {
            draft = ""
            drafts[selectedConversationID ?? "new"] = nil
            drafts["new"] = nil
            draftAttachments = []
            attachmentDrafts[selectedConversationID ?? "new"] = nil
            attachmentDrafts["new"] = nil
        }
        guard await persist(), !Task.isCancelled else { return false }
        await generateResponse(conversationID: targetID, model: chosenModel, onResponseText: onResponseText)
        return conversationErrors[targetID] == nil && !Task.isCancelled
    }

    /// Retries the failed operation without replacing unreadable history or duplicating a user turn.
    func recoverFromChatError() async {
        if !historyAvailable {
            await loadHistory()
            guard historyAvailable else { return }
            chatError = nil
        }
        if selectedModel == nil { await refreshModels(); return }
        guard selectedConversationID != nil else {
            if await persist() { chatError = nil }
            return
        }
        await retry()
    }

    func retry() async {
        guard !isStreaming, let index = conversationIndex, historyAvailable, let chosenModel = selectedModel else { return }
        let targetID = conversations[index].id
        if let last = conversations[index].messages.lastIndex(where: { $0.deletedAt == nil }),
           conversations[index].messages[last].role == .assistant {
            conversations[index].messages[last].deletedAt = Date()
        }
        guard messages.last?.role == .user else { return }
        guard await persist() else { return }
        await generateResponse(conversationID: targetID, model: chosenModel)
    }

    @discardableResult
    func compactContext(instructions: String? = nil) async -> Bool {
        guard !isStreaming, let conversationID = selectedConversationID, let model = selectedModel,
              !model.usesHostedAgent, supportsContextCompaction, let session,
              let index = conversations.firstIndex(where: { $0.id == conversationID }) else { return false }
        let source = conversations[index].messages
        let active = source.filter { $0.deletedAt == nil }
        guard let boundary = NativeContextCompaction.boundary(in: active) else {
            chatError = NativeCompactionError.nothingToCompact.localizedDescription
            return false
        }
        let epoch = lifetime
        let run = ChatRun(replyID: active[boundary].id)
        var saved = false
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                guard let checkpoint = try await streamChat(messages: Array(active.prefix(boundary + 1)),
                    conversationID: conversationID, model: model, token: session.token,
                    compact: true, instructions: instructions, onEvent: { _ in }) else { throw NativeCompactionError.invalidCheckpoint }
                try Task.checkCancellation()
                guard epoch == lifetime else { return }
                guard let current = conversations.firstIndex(where: { $0.id == conversationID }),
                      conversations[current].messages == source,
                      let messageIndex = conversations[current].messages.firstIndex(where: { $0.id == active[boundary].id }) else {
                    throw NativeCompactionError.conversationChanged
                }
                let updated = try NativeContextCompaction.applying(checkpoint, to: active[boundary])
                let previousContext = conversations[current].contextSize
                conversations[current].messages[messageIndex] = updated
                conversations[current].contextSize = NativeContextCompaction.contextSize(in: updated.metadata)
                saved = await persist()
                if !saved, epoch == lifetime,
                   let current = conversations.firstIndex(where: { $0.id == conversationID }),
                   let position = conversations[current].messages.firstIndex(where: { $0 == updated }) {
                    conversations[current].messages[position] = active[boundary]
                    conversations[current].contextSize = previousContext
                }
            } catch is CancellationError {
            } catch {
                if epoch == lifetime { conversationErrors[conversationID] = error.localizedDescription; if selectedConversationID == conversationID { chatError = error.localizedDescription } }
            }
            if epoch == lifetime, compactions[conversationID]?.id == run.id { compactions[conversationID] = nil }
            run.task = nil
        }
        run.task = task
        compactions[conversationID] = run
        await task.value
        return saved
    }

    /// Stops one conversation without interrupting responses in other chats.
    func stop(conversationID: String? = nil) async {
        guard let id = conversationID ?? selectedConversationID else { return }
        compactions.removeValue(forKey: id)?.task?.cancel()
        guard let run = runs.removeValue(forKey: id) else { return }
        run.task?.cancel()
        run.task = nil
        await persist()
    }

    func stopAll() async {
        for run in compactions.values { run.task?.cancel(); run.task = nil }
        compactions = [:]
        let active = runs.values
        runs = [:]
        for run in active { run.task?.cancel(); run.task = nil }
        if !active.isEmpty { await persist() }
    }

    private func generateResponse(conversationID: String, model: ChatModel, onResponseText: (@MainActor @Sendable (String) -> Void)? = nil) async {
        guard let session, let index = conversations.firstIndex(where: { $0.id == conversationID && $0.deletedAt == nil }),
              runs[conversationID] == nil else { return }
        var history = conversations[index].messages.filter { $0.deletedAt == nil && (!$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || $0.parts?.isEmpty == false) }
        if let project = projectLibrary?.projects.first(where: { $0.id == conversations[index].projectID }),
           let instructions = project.promptSection {
            history.insert(ChatMessage(role: .system, text: instructions), at: 0)
        }
        (client as? CloudClient)?.attachmentOwner = owner
        let reply = ChatMessage(role: .assistant, text: "", parentID: history.last(where: { $0.role != .system })?.id, modelID: model.id)
        conversations[index].messages.append(reply)
        let run = ChatRun(replyID: reply.id)
        runs[conversationID] = run
        conversationErrors[conversationID] = nil
        chatError = nil
        run.status = nativeString("Thinking…")
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                try await streamChat(messages: history, conversationID: conversationID, model: model,
                                        token: session.token) { [weak self] event in
                    guard let self, self.runs[conversationID]?.id == run.id,
                          let chatIndex = self.conversations.firstIndex(where: { $0.id == conversationID }),
                          let replyIndex = self.conversations[chatIndex].messages.firstIndex(where: { $0.id == reply.id }) else { return }
                    let previousText = self.conversations[chatIndex].messages[replyIndex].text
                    switch event {
                    case .text(let text):
                        self.conversations[chatIndex].messages[replyIndex].text += text
                        run.status = nil
                    case .content(let parts, let metadata):
                        self.conversations[chatIndex].messages[replyIndex].parts = parts
                        self.conversations[chatIndex].messages[replyIndex].metadata = metadata
                        self.conversations[chatIndex].messages[replyIndex].text = parts.filter(\.isText).compactMap(\.text).joined()
                        if let contextSize = NativeContextCompaction.contextSize(in: metadata) {
                            self.conversations[chatIndex].contextSize = contextSize
                        }
                        run.status = nil
                    case .status(let text): run.status = text
                    case .finished: run.status = nil
                    }
                    let responseText = self.conversations[chatIndex].messages[replyIndex].text
                    if responseText.hasPrefix(previousText), responseText.count > previousText.count {
                        onResponseText?(String(responseText.dropFirst(previousText.count)))
                    }
                }
                try Task.checkCancellation()
                if runs[conversationID]?.id == run.id,
                   let response = conversations.first(where: { $0.id == conversationID })?.messages.first(where: { $0.id == reply.id }),
                   response.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                   response.parts?.contains(where: { $0.isTool || $0.isAttachment || $0.isQuote }) != true {
                    throw CloudError.interrupted
                }
            } catch is CancellationError {
                // The explicit Stop action already saved the partial response.
            } catch {
                if runs[conversationID]?.id == run.id {
                    if case CloudError.http(401, _) = error { await expireSession() }
                    else {
                        conversationErrors[conversationID] = error.localizedDescription
                        if selectedConversationID == conversationID { chatError = error.localizedDescription }
                    }
                }
            }
            guard runs[conversationID]?.id == run.id else { return }
            runs[conversationID] = nil
            run.task = nil
            await persist()
        }
        run.task = task
        await task.value
    }

    @discardableResult
    private func streamChat(
        messages: [ChatMessage], conversationID: String, model: ChatModel, token: String,
        compact: Bool = false, instructions: String? = nil,
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws -> ChatJSONValue? {
        guard !model.usesHostedAgent, client is CloudClient, let library = modelLibrary,
              session != nil, let owner,
              let conversation = conversations.first(where: { $0.id == conversationID }) else {
            guard !compact else { throw CloudError.invalidResponse }
            try await client.stream(messages: messages, conversationID: conversationID, model: model, token: token, onEvent: onEvent)
            return nil
        }
        let epoch = lifetime
        try await reasoningWrite?.value
        let configuration = try await library.repository.runtimeConfiguration(
            modelID: model.id, threadID: conversationID, isEncryptedThread: conversation.isPrivate == true
        )
        try Task.checkCancellation()
        guard epoch == lifetime else { throw CancellationError() }
        let backendURL = try ServerAddress.normalize(serverURL)
        let agentClient = try nativeAgentClient(token: token)
        let reasoning = try await resolveReasoning(configuration, agent: agentClient)
        let userTinfoil = configuration.model.provider == "tinfoil" && configuration.model.isSystem != 1
        let userTinfoilURL = userTinfoil ? try await agentClient.prepareUserTinfoilTransport() : nil
        try Task.checkCancellation()
        guard epoch == lifetime else { throw CancellationError() }
        let resolved = try NativePiModelDescriptor.build(runtime: configuration, backendURL: backendURL,
            token: token, deviceID: deviceCoordinator?.record?.id, tinfoilUserBaseURL: userTinfoilURL, reasoning: reasoning)
        let registration = resolved.transportRegistration.map { registration in
            ChatJSONValue.object(["id": .string(registration.id), "kind": .string(registration.kind.rawValue),
                "baseURL": .string(registration.baseURL.absoluteString)])
        }
        let toolsEnabled = configuration.model.toolUsage == 1
        let settings = library.snapshot?.settings ?? [:]
        let lastUserText = messages.last(where: { $0.role == .user })?.text ?? ""
        let skills = toolsEnabled ? skillLibrary?.enabled ?? [] : []
        let project = projectLibrary?.projects.first { $0.id == conversation.projectID }
        let siblings = project.map { project in
            conversations.filter { $0.projectID == project.id && $0.id != conversationID && $0.deletedAt == nil }
        } ?? []
        let webEnabled = toolsEnabled && settings["integrations_pro_is_enabled"] == "true"
        let mcpTools = toolsEnabled ? try await mcpLibrary?.prepareTools() ?? [] : []
        try Task.checkCancellation()
        guard epoch == lifetime else { throw CancellationError() }
        let mcpLibrary = self.mcpLibrary
        let mcpCall: NativeMCPToolCall = { @MainActor [weak self, weak mcpLibrary] serverID, name, arguments in
            guard self?.lifetime == epoch, let mcpLibrary,
                  mcpTools.contains(where: { $0.serverID == serverID && $0.toolName == name }) else {
                throw NativeLocalToolError.unavailable
            }
            let result = try await mcpLibrary.callTool(serverID: serverID, name: name, arguments: arguments)
            try Task.checkCancellation()
            guard self?.lifetime == epoch else { throw CancellationError() }
            return try JSONDecoder().decode(ChatJSONValue.self, from: JSONEncoder().encode(result))
        }
        var toolNames = toolsEnabled ? ["bash", "read", "write", "edit", "render_html"] : []
        toolNames += mcpTools.map(\.name)
        if toolsEnabled && webEnabled { toolNames += ["search", "fetch_content"] }
        if toolsEnabled && !skills.isEmpty { toolNames.append("skill") }
        if toolsEnabled && !siblings.isEmpty { toolNames.append("search_project_chats") }
        var toolHeaders = ["Authorization": "Bearer " + token,
            "X-App-Version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.164",
            "X-App-Language": settings["language"] ?? NativeLocalization.language]
        if let deviceID = deviceCoordinator?.record?.id { toolHeaders["X-Device-ID"] = deviceID }
        let tokens = SkillLibrary.tokens(in: lastUserText)
        let intent = tokens.contains("research") ? "research" : tokens.contains("search") ? "search" : "auto"
        var toolContext: [String: ChatJSONValue] = [
            "backendURL": .string(backendURL.absoluteString), "headers": .object(toolHeaders.mapValues(ChatJSONValue.string)),
            "webEnabled": .bool(webEnabled), "webIntent": .string(intent),
            "skills": .array(skills.map(\.definition)), "renderHTML": .bool(toolsEnabled),
            "mcpTools": try JSONDecoder().decode(ChatJSONValue.self, from: JSONEncoder().encode(mcpTools)),
        ]
        if let project, !siblings.isEmpty {
            toolContext["projectChats"] = .object(["projectName": .string(project.name), "threadIds": .array(siblings.map { .string($0.id) })])
        }
        let options: ChatJSONValue = .object([
            "model": resolved.descriptor,
            "requestHeaders": .object(resolved.requestHeaders.mapValues(ChatJSONValue.string)),
            "transportRegistration": registration ?? .null,
            "thinkingLevel": .string(resolved.thinkingLevel), "threadId": .string(conversationID),
            "reasoningEffort": reasoning.requestEffort.map(ChatJSONValue.string) ?? .null,
            "providerOptions": try configuration.profile?.providerOptionsJSON.map { try JSONDecoder().decode(ChatJSONValue.self, from: Data($0.utf8)) } ?? .null,
            "clientAppVersion": .string(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.164"),
            "codingToolsEnabled": .bool(toolsEnabled),
            "toolContext": .object(toolContext),
            "promptContext": NativePromptContext.make(model: configuration, settings: settings,
                projectSection: messages.filter { $0.role == .system }.map(\.text).joined(separator: "\n\n"),
                availableToolNames: toolNames),
        ])
        if compact {
            return try await agentClient.compactConversation(messages: messages.filter { $0.role != .system }, owner: owner,
                attachmentStore: attachmentStore, options: options, workspaceEnabled: toolsEnabled,
                instructions: instructions, projectConversations: siblings,
                credentials: userTinfoil ? library.tinfoilCredentials(for: configuration.model) : nil)
        }
        try await agentClient.streamConversation(messages: messages.filter { $0.role != .system }, owner: owner,
            attachmentStore: attachmentStore, options: options, workspaceEnabled: toolsEnabled,
            skillInstructions: skillLibrary?.instructions(in: lastUserText) ?? [], projectConversations: siblings,
            mcpCall: mcpCall,
            credentials: userTinfoil ? library.tinfoilCredentials(for: configuration.model) : nil, onEvent: onEvent)
        return nil
    }

    private func loadHistory() async {
        guard let owner else { return }
        let epoch = lifetime
        do {
            let loaded = try await conversationStore.load(owner: owner)
            guard epoch == lifetime else { return }
            conversations = loaded
            historyAvailable = true
            selectedConversationID = conversations.filter { $0.deletedAt == nil }.max { $0.updatedAt < $1.updatedAt }?.id
            selectedProjectID = conversationIndex.flatMap { conversations[$0].projectID }
            if let index = conversationIndex { selectedModelID = conversations[index].modelID ?? "" }
        } catch {
            guard epoch == lifetime else { return }
            historyAvailable = false
            chatError = nativeString("Your saved chats could not be opened. Restart the app to try again.")
        }
    }

    @discardableResult
    private func persist() async -> Bool {
        guard let owner, historyAvailable else { return false }
        let epoch = lifetime
        pendingWrites += 1
        defer {
            pendingWrites -= 1
            if pendingWrites == 0, let repository = conversationStore as? SyncedConversationStore {
                Task { [weak self] in
                    do {
                        let loaded = try await repository.snapshot(owner: owner)
                        guard let self, self.lifetime == epoch else { return }
                        self.applySyncedConversations(loaded)
                    } catch is CancellationError {
                    } catch {
                        if let self, self.lifetime == epoch { self.syncError = error.localizedDescription }
                    }
                }
            }
        }
        do {
            try await conversationStore.save(conversations, owner: owner)
            return epoch == lifetime
        } catch {
            if epoch == lifetime { chatError = nativeString("Your chat could not be saved on this device.") }
            return false
        }
    }

    private func handleChatError(_ error: Error) async {
        if case CloudError.http(401, _) = error { await expireSession() }
        else { chatError = error.localizedDescription }
    }

    private func expireSession() async {
        guard !isResettingLocalAccount else { return }
        await stopAll()
        await disconnectSync()
        do { try sessionStore.save(nil, server: serverURL) }
        catch { chatError = error.localizedDescription; return }
        lifetime = UUID()
        session = nil
        conversations = []
        selectedConversationID = nil
        models = []
        draft = ""
        drafts = [:]
        conversationErrors = [:]
        draftAttachments = []
        attachmentDrafts = [:]
        isImportingAttachments = false
        attachmentError = nil
        isLoadingModels = false
        isAuthenticating = false
        backToEmail()
        authError = nativeString("Your session has expired. Please sign in again.")
    }
}
