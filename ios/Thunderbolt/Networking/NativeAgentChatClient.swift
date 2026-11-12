/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

/// A session token shared with the SDK's request-time authentication callback.
final class NativeSessionToken: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    init(_ value: String) { self.value = value }
    func read() -> String? { lock.withLock { value } }
    func update(_ value: String?) { lock.withLock { self.value = value } }
}

actor NativeCredentialRoutes {
    private var resolvers: [String: @Sendable () async throws -> String] = [:]
    func register(_ id: String, resolver: @escaping @Sendable () async throws -> String) { resolvers[id] = resolver }
    func remove(_ id: String) { resolvers[id] = nil }
    func clear() { resolvers = [:] }
    func resolve(_ id: String) async throws -> String {
        guard let resolver = resolvers[id] else { throw NativeTinfoilOAuthError.credentialUnavailable }
        return try await resolver()
    }
}

/// Owns an account's in-process Pi engine. Each turn has a cancellable harness;
/// its durable workspace is scoped by the account and conversation, not the UI.
@MainActor
final class NativeAgentChatClient {
    private let initialization: Task<PiAgentRuntime, Error>
    private let token: NativeSessionToken
    private let confidentialFactory: ManagedTinfoilChatClientFactory
    private let userTinfoilFactory: NativeTinfoilUserClientFactory
    private let serverURL: URL
    private let userID: String
    private let localTools: NativeLocalTools
    private let credentialRoutes: NativeCredentialRoutes
    private var activeHarnesses: Set<String> = []
    private var isClosed = false

    init(serverURL: URL, userID: String, sessionToken: String, deviceID: String?, cacheSecret: String,
         attestation: NativeTinfoilAttestationStatus? = nil) throws {
        self.serverURL = serverURL
        self.userID = userID
        let localTools = NativeLocalTools()
        self.localTools = localTools
        let credentialRoutes = NativeCredentialRoutes()
        self.credentialRoutes = credentialRoutes
        let token = NativeSessionToken(sessionToken)
        self.token = token
        let factory = ManagedTinfoilChatClientFactory(configuration: ManagedTinfoilProviderConfiguration(
            backendURL: serverURL, userCacheSecret: cacheSecret,
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.164",
            deviceID: deviceID, attestationCallbacks: attestation?.callbacks(for: "managed"), sessionToken: { token.read() }
        ))
        confidentialFactory = factory
        let userTinfoilFactory = NativeTinfoilUserClientFactory(userCacheSecret: cacheSecret,
            attestationCallbacks: attestation?.callbacks(for: "user"))
        self.userTinfoilFactory = userTinfoilFactory
        let confidential = try NativeManagedTinfoilInferenceAdapter(backendURL: serverURL, factory: factory)
        let userTinfoil = NativeTinfoilUserInferenceAdapter(factory: userTinfoilFactory,
            accessToken: { id in try await credentialRoutes.resolve(id) })
        initialization = Task.detached(priority: .userInitiated) {
            try PiAgentRuntime(serverURL: serverURL, userID: userID, confidentialInference: confidential,
                userTinfoilInference: userTinfoil, localToolHandler: localTools)
        }
    }

    func updateSessionToken(_ value: String) { token.update(value) }

    func prepareUserTinfoilTransport() async throws -> URL { try await userTinfoilFactory.prepare() }

    func verifyConfidentialConnection(userProvided: Bool) async throws {
        if userProvided { try await userTinfoilFactory.verify() }
        else { try await confidentialFactory.verify() }
    }

    func supportsCompaction(configuration: NativeModelRuntimeConfiguration) async throws -> Bool {
        let runtime = try await initialization.value
        try Task.checkCancellation()
        guard !isClosed else { throw CancellationError() }
        let model = configuration.model
        let descriptor: ChatJSONValue = .object([
            "provider": .string(model.provider), "model": .string(model.model),
            "vendor": model.vendor.map(ChatJSONValue.string) ?? .null,
            "toolUsage": .number(Double(model.toolUsage)),
            "apiKey": model.apiKey.map(ChatJSONValue.string) ?? .null,
            "url": model.url.map(ChatJSONValue.string) ?? .null,
        ])
        return try await runtime.supportsCompaction(modelJSON: Self.json(descriptor))
    }

    func resolveReasoning(
        configuration: NativeModelRuntimeConfiguration, capabilities: NativeReasoningCapabilities?
    ) async throws -> NativeReasoningResolution {
        let runtime = try await initialization.value
        try Task.checkCancellation()
        guard !isClosed else { throw CancellationError() }
        let model = configuration.model
        let provider = model.provider == "thunderbolt" ? model.vendor ?? model.provider : model.provider
        let modelID = model.provider == "thunderbolt" && provider == "anthropic"
            ? (model.model == "opus-5-5" ? "claude-opus-5" : "claude-" + model.model) : model.model
        let capabilityJSON = try capabilities.map { String(decoding: try JSONEncoder().encode($0), as: UTF8.self) }
        let result = try await runtime.resolveReasoning(provider: provider, modelID: modelID,
            savedEffort: configuration.reasoningEffort, profileOptionsJSON: configuration.profile?.providerOptionsJSON,
            capabilitiesJSON: capabilityJSON)
        return try JSONDecoder().decode(NativeReasoningResolution.self, from: Data(result.utf8))
    }

    func streamConversation(
        messages: [ChatMessage],
        owner: String,
        attachmentStore: AttachmentStore,
        options: ChatJSONValue,
        workspaceEnabled: Bool,
        skillInstructions: [String] = [],
        projectConversations: [Conversation] = [],
        mcpCall: NativeMCPToolCall? = nil,
        credentials: (@Sendable () async throws -> String)? = nil,
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws {
        let runtime = try await initialization.value
        try Task.checkCancellation()
        guard !isClosed else { throw CancellationError() }
        let inputs = try await conversationInputs(messages: messages, owner: owner, attachmentStore: attachmentStore)
        let preparedJSON = try await runtime.prepareConversation(
            messagesJSON: inputs.messages, attachmentsJSON: inputs.attachments,
            workspaceEnabled: workspaceEnabled,
            skillInstructionsJSON: skillInstructions.isEmpty ? "null" : Self.json(.array(skillInstructions.map(ChatJSONValue.string)))
        )
        let prepared = try JSONDecoder().decode(ChatJSONValue.self, from: Data(preparedJSON.utf8))
        guard var merged = options.objectValue,
              let history = prepared["history"], let prompt = prepared["prompt"]?["text"]?.stringValue else {
            throw CloudError.invalidResponse
        }
        merged["history"] = history
        merged["workspaceFiles"] = prepared["files"] ?? .array([])
        if let compaction = prepared["compaction"] { merged["compaction"] = compaction }
        let contextID = await localTools.configure(threadID: options["threadId"]?.stringValue ?? "", conversations: projectConversations, mcpCall: mcpCall)
        merged["localToolContextID"] = .string(contextID)
        let credentialID = options["transportRegistration"]?["id"]?.stringValue
        if let credentialID, let credentials { await credentialRoutes.register(credentialID, resolver: credentials) }
        do {
            try await stream(options: .object(merged), prompt: prompt,
                images: prepared["prompt"]?["images"] ?? .array([]), onEvent: onEvent)
        } catch {
            await localTools.remove(threadID: contextID)
            if let credentialID { await credentialRoutes.remove(credentialID) }
            throw error
        }
        await localTools.remove(threadID: contextID)
        if let credentialID { await credentialRoutes.remove(credentialID) }
    }

    private func conversationInputs(messages: [ChatMessage], owner: String, attachmentStore: AttachmentStore) async throws -> (messages: String, attachments: String) {
        var attachments: [ChatJSONValue] = []
        var loaded: Set<String> = []
        var wireMessages: [ChatJSONValue] = []
        for message in messages {
            let parts = ChatMessageContent(message: message).parts
            for reference in parts.compactMap(AttachmentReference.init(part:)) where loaded.insert(reference.id).inserted {
                guard let file = try await attachmentStore.load(reference, owner: owner) else { continue }
                var attachment: [String: ChatJSONValue] = [
                    "localFileId": .string(reference.id), "filename": .string(file.reference.filename),
                    "mimeType": .string(file.reference.mimeType), "base64": .string(file.bytes.base64EncodedString()),
                ]
                if let text = try await attachmentStore.extractedText(file) { attachment["extractedText"] = .string(text) }
                attachments.append(.object(attachment))
            }
            wireMessages.append(.object([
                "id": .string(message.id), "role": .string(message.role.rawValue),
                "parts": .array(parts.map(\.rawValue)), "metadata": message.metadata ?? .object([:]),
                "cache": message.cache ?? .object([:]),
            ]))
        }
        return (try Self.json(.array(wireMessages)), try Self.json(.array(attachments)))
    }

    func compactConversation(
        messages: [ChatMessage], owner: String, attachmentStore: AttachmentStore,
        options: ChatJSONValue, workspaceEnabled: Bool, instructions: String?,
        projectConversations: [Conversation] = [],
        credentials: (@Sendable () async throws -> String)? = nil
    ) async throws -> ChatJSONValue {
        let runtime = try await initialization.value
        try Task.checkCancellation()
        guard !isClosed, var merged = options.objectValue else { throw CancellationError() }
        let inputs = try await conversationInputs(messages: messages, owner: owner, attachmentStore: attachmentStore)
        let contextID = await localTools.configure(threadID: options["threadId"]?.stringValue ?? "", conversations: projectConversations)
        merged["localToolContextID"] = .string(contextID)
        let credentialID = options["transportRegistration"]?["id"]?.stringValue
        if let credentialID, let credentials { await credentialRoutes.register(credentialID, resolver: credentials) }
        do {
            let result = try await runtime.compactConversation(optionsJSON: Self.json(.object(merged)),
                messagesJSON: inputs.messages, attachmentsJSON: inputs.attachments,
                workspaceEnabled: workspaceEnabled, instructions: instructions)
            await localTools.remove(threadID: contextID)
            if let credentialID { await credentialRoutes.remove(credentialID) }
            try Task.checkCancellation()
            guard !isClosed else { throw CancellationError() }
            return try JSONDecoder().decode(ChatJSONValue.self, from: Data(result.utf8))
        } catch {
            await localTools.remove(threadID: contextID)
            if let credentialID { await credentialRoutes.remove(credentialID) }
            throw error
        }
    }

    func stream(
        options: ChatJSONValue,
        prompt: String,
        images: ChatJSONValue = .array([]),
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws {
        guard !isClosed else { throw CancellationError() }
        let runtime = try await initialization.value
        try Task.checkCancellation()
        guard !isClosed else { throw CancellationError() }
        let optionsJSON = String(decoding: try JSONEncoder().encode(options), as: UTF8.self)
        let imagesJSON = String(decoding: try JSONEncoder().encode(images), as: UTF8.self)
        let harnessID = try await withCheckedThrowingContinuation { continuation in
            runtime.createHarness(optionsJSON: optionsJSON) { continuation.resume(with: $0) }
        }
        defer {
            activeHarnesses.remove(harnessID)
            runtime.dispose(harnessID: harnessID)
        }
        try Task.checkCancellation()
        guard !isClosed else { throw CancellationError() }
        activeHarnesses.insert(harnessID)
        let chunks = AsyncThrowingStream<String, Error> { continuation in
            continuation.onTermination = { _ in runtime.stop(harnessID: harnessID) }
            runtime.run(harnessID: harnessID, prompt: prompt, imagesJSON: imagesJSON,
                onChunk: { continuation.yield($0) },
                onComplete: { error in
                    if let error { continuation.finish(throwing: error) }
                    else { continuation.finish() }
                })
        }
        let emitter = StreamEventEmitter(onEvent: onEvent)
        defer { emitter.flushText() }
        var parser = SSEParser()
        try await withTaskCancellationHandler {
            for try await chunk in chunks {
                try Task.checkCancellation()
                for frame in parser.append(Data(chunk.utf8)) {
                    if try emitter.consumeUIMessage(frame) { emitter.emit(.finished) }
                }
            }
            try Task.checkCancellation()
            for frame in parser.finish() {
                if try emitter.consumeUIMessage(frame) { emitter.emit(.finished) }
            }
            guard emitter.didFinish else { throw CloudError.interrupted }
        } onCancel: {
            runtime.stop(harnessID: harnessID)
        }
    }

    func close(removeWorkspaces: Bool = false) async throws {
        isClosed = true
        token.update(nil)
        do {
            if case .success(let runtime) = await initialization.result {
                try await runtime.shutdown()
            }
            if removeWorkspaces { try NativeAgentWorkspaceStore.removeAccount(serverURL: serverURL, userID: userID) }
        } catch {
            await confidentialFactory.reset()
            await userTinfoilFactory.reset()
            await credentialRoutes.clear()
            await localTools.clear()
            throw error
        }
        await confidentialFactory.reset()
        await userTinfoilFactory.reset()
        await localTools.clear()
        await credentialRoutes.clear()
    }

    private static func json(_ value: ChatJSONValue) throws -> String {
        String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
    }
}
