/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

@MainActor
protocol CloudServing {
    func sendCode(email: String) async throws -> String?
    func verifyCode(email: String, code: String, challenge: String) async throws -> CloudSession
    func restoreSession(token: String) async throws -> CloudSession?
    func signOut(token: String) async throws
    func loadModels(token: String) async throws -> [ChatModel]
    func stream(
        messages: [ChatMessage],
        conversationID: String,
        model: ChatModel,
        token: String,
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws
}

@MainActor
final class CloudClient: CloudServing {
    private let baseURL: URL
    private let session: URLSession
    var deviceID: String?
    var attachmentOwner: String?
    var onAccessInvalidation: ((NativeAccountAccess) -> Void)?
    private(set) var modelDefaults: NativeModelDefaultsPayload?
    private let attachmentStore: AttachmentStore

    init(baseURL: URL, session: URLSession = CloudClient.makeSession(), attachmentStore: AttachmentStore = AttachmentStore()) {
        self.baseURL = baseURL
        self.session = session
        self.attachmentStore = attachmentStore
    }

    func sendCode(email: String) async throws -> String? {
        let response = try await sendJSON(path: "waitlist/join", body: EmailRequest(email: email))
        let payload = try decode(JoinResponse.self, from: response.data)
        return payload.challengeToken
    }

    func verifyCode(email: String, code: String, challenge: String) async throws -> CloudSession {
        var request = try makeRequest(path: "api/auth/sign-in/email-otp", method: "POST")
        request.httpBody = try JSONEncoder().encode(VerifyRequest(email: email, otp: code))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(challenge, forHTTPHeaderField: "x-challenge-token")
        let response = try await perform(request)
        guard let token = response.http.value(forHTTPHeaderField: "set-auth-token"), !token.isEmpty else {
            throw CloudError.missingToken
        }
        let payload = try decode(SessionResponse.self, from: response.data)
        return CloudSession(token: token, user: payload.user)
    }

    func restoreSession(token: String) async throws -> CloudSession? {
        var request = try makeRequest(path: "api/auth/get-session", method: "GET", token: token)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let response = try await perform(request)
            guard let payload = try? JSONSerialization.jsonObject(with: response.data, options: .fragmentsAllowed) else {
                throw CloudError.invalidResponse
            }
            if payload is NSNull {
                return nil
            }
            guard let object = payload as? [String: Any],
                  let userObject = object["user"] as? [String: Any]
            else { throw CloudError.invalidResponse }
            let user = try decode(CloudUser.self, from: JSONSerialization.data(withJSONObject: userObject))
            let refreshedToken = response.http.value(forHTTPHeaderField: "set-auth-token") ?? token
            return CloudSession(token: refreshedToken, user: user)
        } catch CloudError.http(let status, _) where status == 401 {
            return nil
        }
    }

    func signOut(token: String) async throws {
        var request = try makeRequest(path: "api/auth/sign-out", method: "POST", token: token)
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await perform(request)
    }

    func loadModels(token: String) async throws -> [ChatModel] {
        let config = try await perform(try makeRequest(path: "config", method: "GET", token: token))
        let agents = try await perform(try makeRequest(path: "agents", method: "GET", token: token))
        let configPayload = try decode(ConfigResponse.self, from: config.data)
        if configPayload.defaults?.models?.version != nil {
            modelDefaults = try decode(NativeModelConfigResponse.self, from: config.data).defaults?.models
        }
        let agentsPayload = try decode(AgentResponse.self, from: agents.data)

        let serverModels = configPayload.builtInAgentEnabled == false ? [] : configPayload.defaults?.models?.data ?? []
        let managedModels = serverModels
            .filter { $0.provider == "thunderbolt" && $0.enabled != 0 && $0.deletedAt == nil }
            .map {
                ChatModel(
                    id: $0.id,
                    name: $0.name,
                    model: $0.model,
                    vendor: $0.vendor,
                    endpoint: nil
                )
            }
        let hostedAgents = (agentsPayload.agents ?? [])
            .filter { $0.type == "managed-http" && $0.isSystem == 1 }
            .compactMap { agent -> ChatModel? in
                guard let endpoint = agent.url, Self.isSafeHostedPath(endpoint) else {
                    return nil
                }
                return ChatModel(
                    id: agent.id,
                    name: agent.name,
                    model: agent.id,
                    vendor: nil,
                    endpoint: endpoint
                )
            }

        let defaultID = configPayload.defaults?.models?.defaultModelId
        let sortedModels = managedModels.sorted { lhs, rhs in
            if lhs.id == defaultID { return true }
            if rhs.id == defaultID { return false }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
        let models = agentsPayload.defaultAgentId == "hosted-agent"
            ? hostedAgents + sortedModels
            : sortedModels + hostedAgents
        guard !models.isEmpty else {
            throw CloudError.noModels
        }
        return models
    }

    func stream(
        messages: [ChatMessage],
        conversationID: String,
        model: ChatModel,
        token: String,
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws {
        let wire: StreamWire
        let path: String
        if let hostedPath = model.endpoint {
            guard Self.isSafeHostedPath(hostedPath) else {
                throw CloudError.invalidServer
            }
            path = String(hostedPath.dropFirst(4))
            wire = .uiMessage
        } else if model.vendor == "anthropic" {
            path = "chat/v1/messages"
            wire = .anthropic
        } else {
            path = "chat/completions"
            wire = .openAI
        }

        var request = try makeRequest(path: path, method: "POST", token: token)
        request.timeoutInterval = 180
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if wire == .anthropic {
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        }
        request.httpBody = try await encodeStreamBody(
            messages: messages,
            conversationID: conversationID,
            model: model,
            wire: wire
        )
        try Task.checkCancellation()

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CloudError.invalidResponse
        }
        try validateFinalURL(response.url)
        guard (200..<300).contains(http.statusCode) else {
            let body = await collect(bytes)
            reportAccessInvalidation(status: http.statusCode, data: body, request: request)
            throw CloudError.http(http.statusCode, safeMessage(from: body))
        }

        var parser = SSEParser()
        let emitter = StreamEventEmitter(onEvent: onEvent)
        var chunk = Data()
        chunk.reserveCapacity(128)
        do {
            for try await byte in bytes {
                chunk.append(byte)
                guard byte == 10 || byte == 13 else { continue }
                try consume(parser.append(chunk), wire: wire, emitter: emitter)
                chunk.removeAll(keepingCapacity: true)
            }
            if !chunk.isEmpty {
                try consume(parser.append(chunk), wire: wire, emitter: emitter)
            }
            try consume(parser.finish(), wire: wire, emitter: emitter)
        } catch {
            emitter.flushText()
            throw error
        }
        guard emitter.didFinish else {
            emitter.flushText()
            throw CloudError.interrupted
        }
    }

    private func sendJSON<Body: Encodable>(path: String, body: Body) async throws -> (data: Data, http: HTTPURLResponse) {
        var request = try makeRequest(path: path, method: "POST")
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await perform(request)
    }

    func perform(_ request: URLRequest) async throws -> (data: Data, http: HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CloudError.invalidResponse
        }
        try validateFinalURL(response.url)
        guard (200..<300).contains(http.statusCode) else {
            reportAccessInvalidation(status: http.statusCode, data: data, request: request)
            throw CloudError.http(http.statusCode, safeMessage(from: data))
        }
        return (data, http)
    }

    private func reportAccessInvalidation(status: Int, data: Data, request: URLRequest) {
        guard request.value(forHTTPHeaderField: "Authorization") != nil,
              let reason = NativeAccountAccess.decode(status: status, data: data), reason != .sessionExpired else { return }
        onAccessInvalidation?(reason)
    }

    func makeRequest(path: String, method: String, token: String? = nil) throws -> URLRequest {
        let isSecure = baseURL.scheme?.lowercased() == "https"
        let isLocalDevelopment = baseURL.scheme?.lowercased() == "http" &&
            ["localhost", "127.0.0.1", "::1", "[::1]"].contains(baseURL.host?.lowercased() ?? "")
        guard isSecure || isLocalDevelopment,
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil
        else {
            throw CloudError.invalidServer
        }

        components.path = baseURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let basePath = components.path.isEmpty ? "" : "/\(components.path)"
        components.path = "\(basePath)/\(path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))"
        guard let url = components.url else {
            throw CloudError.invalidServer
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(clientPlatform, forHTTPHeaderField: "X-Client-Platform")
        request.setValue(clientLanguage, forHTTPHeaderField: "X-App-Language")
        request.setValue(clientVersion, forHTTPHeaderField: "X-App-Version")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if let deviceID { request.setValue(deviceID, forHTTPHeaderField: "X-Device-ID") }
        }
        return request
    }

    private func validateFinalURL(_ url: URL?) throws {
        guard let url,
              let expected = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let actual = URLComponents(url: url, resolvingAgainstBaseURL: false),
              expected.scheme?.lowercased() == actual.scheme?.lowercased(),
              expected.host?.lowercased() == actual.host?.lowercased(),
              effectivePort(expected) == effectivePort(actual)
        else {
            throw CloudError.invalidServer
        }
    }

    private func effectivePort(_ components: URLComponents) -> Int? {
        components.port ?? (components.scheme == "https" ? 443 : 80)
    }

    private func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw CloudError.invalidResponse
        }
    }

    private func safeMessage(from data: Data) -> String {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nativeString( "The server could not complete the request.")
        }
        for key in ["message", "error", "code"] {
            if let value = object[key] as? String, !value.isEmpty {
                return value
            }
        }
        if let error = object["error"] as? [String: Any] {
            for key in ["message", "code"] {
                if let value = error[key] as? String, !value.isEmpty {
                    return value
                }
            }
        }
        return nativeString( "The server could not complete the request.")
    }

    private func collect(_ bytes: URLSession.AsyncBytes) async -> Data {
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
            }
        } catch {
            return data
        }
        return data
    }

    private func encodeStreamBody(
        messages: [ChatMessage],
        conversationID: String,
        model: ChatModel,
        wire: StreamWire
    ) async throws -> Data {
        let currentTurn = messages.last(where: { $0.role == .user })?.id
        var hydrated: [String: [ChatContentPart]] = [:]
        for message in messages {
            hydrated[message.id] = try await AttachmentHydrator.parts(for: message,
                isCurrentTurn: message.id == currentTurn, owner: attachmentOwner, store: attachmentStore)
        }
        switch wire {
        case .uiMessage:
            let history = Array(messages.suffix(Self.hostedHistoryMessageLimit).drop(while: { $0.role != .user }))
            let body = UIMessageRequest(
                id: conversationID,
                messages: history.map {
                    UIMessage(role: $0.role.rawValue, id: $0.id, parts: hydrated[$0.id] ?? [], metadata: $0.metadata)
                },
                instructions: messages.filter { $0.role == .system }.map(\.text).nilIfEmpty
            )
            return try JSONEncoder().encode(body)
        case .anthropic:
            return try JSONEncoder().encode(AnthropicRequest(
                model: model.model,
                maxTokens: 8_192,
                stream: true,
                system: messages.filter { $0.role == .system }.map(\.text).nilIfEmpty,
                messages: messages.filter { $0.role != .system }.map {
                    AnthropicMessage(role: $0.role.rawValue, content: AttachmentHydrator.anthropicContent(hydrated[$0.id] ?? []))
                }
            ))
        case .openAI:
            return try JSONEncoder().encode(OpenAIRequest(
                model: model.model,
                stream: true,
                messages: messages.map { OpenAIMessage(role: $0.role.rawValue, content: AttachmentHydrator.openAIContent(hydrated[$0.id] ?? [])) }
            ))
        }
    }

    private func consume(
        _ frame: SSEFrame,
        wire: StreamWire,
        onEvent: @MainActor (ChatStreamEvent) -> Void
    ) throws -> Bool {
        if frame.data == "[DONE]" {
            return true
        }
        guard !frame.data.isEmpty else { return false }
        guard let data = frame.data.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw CloudError.invalidResponse
        }

        switch wire {
        case .uiMessage:
            let type = object["type"] as? String
            if type == "text-delta", let delta = object["delta"] as? String {
                onEvent(.text(delta))
            } else if type == "finish" {
                return true
            } else if type == "error", let message = object["errorText"] as? String {
                throw CloudError.http(500, message)
            }
        case .anthropic:
            switch frame.event ?? object["type"] as? String {
            case "content_block_delta":
                if let delta = object["delta"] as? [String: Any], let text = delta["text"] as? String {
                    onEvent(.text(text))
                }
            case "message_stop":
                return true
            case "error":
                throw CloudError.http(500, safeMessage(from: data))
            default:
                break
            }
        case .openAI:
            if let choices = object["choices"] as? [[String: Any]], let choice = choices.first {
                if let delta = choice["delta"] as? [String: Any], let text = delta["content"] as? String {
                    onEvent(.text(text))
                }
                if let finishReason = choice["finish_reason"], !(finishReason is NSNull) {
                    return true
                }
            }
            if let error = object["error"] {
                throw CloudError.http(500, String(describing: error))
            }
        }
        return false
    }

    private func consume(
        _ frames: [SSEFrame],
        wire: StreamWire,
        emitter: StreamEventEmitter
    ) throws {
        for frame in frames {
            let finished = wire == .uiMessage
                ? try emitter.consumeUIMessage(frame)
                : try consume(frame, wire: wire, onEvent: emitter.emit)
            if finished {
                emitter.emit(.finished)
            }
            emitter.flushTextIfDue()
        }
    }

    private static func isSafeHostedPath(_ path: String) -> Bool {
        path.hasPrefix("/v1/") && !path.hasPrefix("//") && !path.contains("..") && !path.contains("?") && !path.contains("#")
    }

    private static let hostedHistoryMessageLimit = 200

    private var clientVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.164"
    }

    private var clientLanguage: String {
        NativeLocalization.selectedLanguage
    }

    private var clientPlatform: String { "ios" }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: SameOriginRedirectDelegate(), delegateQueue: nil)
    }
}

private enum StreamWire: Equatable {
    case uiMessage
    case anthropic
    case openAI
}

@MainActor
final class StreamEventEmitter {
    private let onEvent: @MainActor (ChatStreamEvent) -> Void
    private let clock: ContinuousClock
    private let interval = Duration.milliseconds(33)
    private var lastTextEmission: ContinuousClock.Instant
    private var pendingText = ""
    private var pendingContent: ChatStreamEvent?
    private var uiMessage = UIMessageStreamState()
    private(set) var didFinish = false

    init(onEvent: @escaping @MainActor (ChatStreamEvent) -> Void) {
        let clock = ContinuousClock()
        self.clock = clock
        self.lastTextEmission = clock.now
        self.onEvent = onEvent
    }

    func emit(_ event: ChatStreamEvent) {
        guard !didFinish else { return }
        switch event {
        case .text(let text):
            pendingText.append(text)
            flushTextIfDue()
        case .content:
            pendingContent = event
            flushTextIfDue()
        case .finished:
            flushText()
            guard !didFinish else { return }
            didFinish = true
            onEvent(event)
        case .status:
            flushText()
            onEvent(event)
        }
    }

    func flushTextIfDue() {
        guard !pendingText.isEmpty || pendingContent != nil,
              lastTextEmission.duration(to: clock.now) >= interval
        else { return }
        flushText()
    }

    func flushText() {
        guard !pendingText.isEmpty || pendingContent != nil else { return }
        let text = pendingText
        pendingText.removeAll(keepingCapacity: true)
        lastTextEmission = clock.now
        if !text.isEmpty { onEvent(.text(text)) }
        if let pendingContent { onEvent(pendingContent) }
        pendingContent = nil
    }

    func consumeUIMessage(_ frame: SSEFrame) throws -> Bool {
        guard !frame.data.isEmpty, !didFinish else { return false }
        let finished = try uiMessage.consume(frame.data)
        emit(.content(parts: uiMessage.parts, metadata: uiMessage.metadata))
        return finished
    }
}

private struct EmailRequest: Encodable { let email: String }
private struct VerifyRequest: Encodable { let email: String; let otp: String }
private struct JoinResponse: Decodable { let challengeToken: String? }
private struct SessionResponse: Decodable { let user: CloudUser }
private struct UIMessageRequest: Encodable { let id: String; let messages: [UIMessage]; let instructions: String? }
private struct UIMessage: Encodable {
    let role: String
    let id: String
    let parts: [ChatContentPart]
    let metadata: ChatJSONValue?
}
private struct AnthropicRequest: Encodable { let model: String; let maxTokens: Int; let stream: Bool; let system: String?; let messages: [AnthropicMessage]
    enum CodingKeys: String, CodingKey { case model, stream, system, messages; case maxTokens = "max_tokens" }
}
private extension Array where Element == String {
    var nilIfEmpty: String? { isEmpty ? nil : joined(separator: "\n\n") }
}
private struct AnthropicMessage: Encodable { let role: String; let content: ChatJSONValue }
private struct OpenAIRequest: Encodable { let model: String; let stream: Bool; let messages: [OpenAIMessage] }
private struct OpenAIMessage: Encodable { let role: String; let content: ChatJSONValue }
private struct ConfigResponse: Decodable {
    let builtInAgentEnabled: Bool?
    let defaults: Defaults?
    struct Defaults: Decodable { let models: Models? }
    struct Models: Decodable { let defaultModelId: String?; let version: Double?; let data: [ModelDescriptor]? }
}
private struct ModelDescriptor: Decodable {
    let id: String
    let name: String
    let model: String
    let provider: String
    let vendor: String?
    let enabled: Int?
    let deletedAt: String?
}
private struct AgentResponse: Decodable { let agents: [AgentDescriptor]?; let defaultAgentId: String? }
private struct AgentDescriptor: Decodable {
    let id: String
    let name: String
    let type: String
    let url: String?
    let isSystem: Int?
}

private final class SameOriginRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let original = task.originalRequest?.url, let redirected = request.url,
              original.scheme?.lowercased() == redirected.scheme?.lowercased(),
              original.host?.lowercased() == redirected.host?.lowercased(),
              original.port == redirected.port
        else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }
}
