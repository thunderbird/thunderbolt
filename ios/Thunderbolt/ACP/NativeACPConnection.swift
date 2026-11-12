/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

enum NativeACPError: Error, Equatable, LocalizedError {
    case insecureURL
    case managedAgentOriginMismatch
    case invalidURL
    case closed
    case timeout
    case rpc(code: Int, message: String)
    case invalidResponse(String)

    var errorDescription: String? {
        switch self {
        case .insecureURL: nativeString("ACP agents on iOS require a secure wss:// URL.")
        case .managedAgentOriginMismatch: nativeString("The managed ACP agent URL does not match this server.")
        case .invalidURL: nativeString("Enter a valid wss:// ACP agent URL.")
        case .closed: nativeString("The ACP agent connection closed.")
        case .timeout: nativeString("The ACP agent did not answer in time.")
        case .rpc(_, let message): message
        case .invalidResponse(let message): message
        }
    }
}

protocol NativeACPTransport: Sendable {
    func send(_ message: ChatJSONValue) async throws
    func receive() async throws -> ChatJSONValue
    func close() async
}

private actor NativeURLSessionACPTransport: NativeACPTransport {
    private let socket: URLSessionWebSocketTask
    private let session: URLSession

    init(socket: URLSessionWebSocketTask, session: URLSession) {
        self.socket = socket
        self.session = session
    }

    func send(_ message: ChatJSONValue) async throws {
        let data = try JSONEncoder().encode(message)
        guard let text = String(data: data, encoding: .utf8) else {
            throw NativeACPError.invalidResponse("Could not encode ACP request.")
        }
        try await socket.send(.string(text))
    }

    func receive() async throws -> ChatJSONValue {
        let message = try await socket.receive()
        let data: Data
        switch message {
        case .string(let value): data = Data(value.utf8)
        case .data(let value): data = value
        @unknown default: throw NativeACPError.invalidResponse("Unsupported ACP WebSocket frame.")
        }
        return try JSONDecoder().decode(ChatJSONValue.self, from: data)
    }

    func close() async {
        socket.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }
}

private extension String {
    var nilIfBlank: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

enum NativeACPEvent: Sendable, Equatable {
    case sessionUpdate(sessionID: String, update: ChatJSONValue)
    case permissionRequest(requestID: ChatJSONValue, sessionID: String, request: ChatJSONValue)
    case connectionClosed(String)
}

typealias NativeACPPermissionHandler = @Sendable (_ sessionID: String, _ request: ChatJSONValue) async -> ChatJSONValue

struct NativeACPCapabilities: Sendable, Equatable {
    let loadSession: Bool
    let resumeSession: Bool
    let wireSkills: Bool
    let promptCapabilities: ChatJSONValue?
}

struct NativeACPWireSkill: Sendable, Equatable {
    let name: String
    let description: String
    let instruction: String
}

struct NativeACPResolvedSession: Sendable, Equatable {
    let sessionID: String
    let restored: Bool
    let created: Bool
}

struct NativeACPConnectionConfiguration: Sendable, Equatable {
    let agent: NativeACPAgent
    let backendURL: URL?
    let sessionToken: String?
    let deviceID: String?
    let appVersion: String?

    init(agent: NativeACPAgent, backendURL: URL? = nil, sessionToken: String? = nil, deviceID: String? = nil, appVersion: String? = nil) {
        self.agent = agent
        self.backendURL = backendURL
        self.sessionToken = sessionToken
        self.deviceID = deviceID
        self.appVersion = appVersion
    }
}

/// One WebSocket/ACP generation. Recreate it after a transport failure; callers
/// persist session IDs per chat thread and ask this connection to restore them.
actor NativeACPConnection {
    private struct PendingRequest {
        let continuation: CheckedContinuation<ChatJSONValue, Error>
        let timeout: Task<Void, Never>?
        let method: String
        let sessionID: String?
    }

    private let transport: any NativeACPTransport
    private let permissionHandler: NativeACPPermissionHandler
    private var nextRequestID = 1
    private var pending: [Int: PendingRequest] = [:]
    private var receiver: Task<Void, Never>?
    private var closed = false
    private var eventContinuation: AsyncStream<NativeACPEvent>.Continuation?
    nonisolated let events: AsyncStream<NativeACPEvent>
    private(set) var capabilities: NativeACPCapabilities?
    var isOpen: Bool { !closed }

    init(
        transport: any NativeACPTransport,
        permissionHandler: @escaping NativeACPPermissionHandler = { _, _ in
            .object(["outcome": .object(["outcome": .string("cancelled")])])
        }
    ) {
        self.transport = transport
        self.permissionHandler = permissionHandler
        let stream = AsyncStream<NativeACPEvent>.makeStream()
        events = stream.stream
        eventContinuation = stream.continuation
    }

    func startReceiving() {
        guard receiver == nil, !closed else { return }
        receiver = Task { [weak self] in await self?.receiveLoop() }
    }

    static func connect(url rawURL: String) async throws -> NativeACPConnection {
        let configuration = NativeACPConnectionConfiguration(
            agent: NativeACPAgent(id: "connection-test", name: "", type: .remote, transport: .websocket,
                url: rawURL, description: nil, icon: nil, enabled: true, isSystem: false, isDefault: false, deletedAt: nil)
        )
        return try await connect(configuration: configuration)
    }

    static func connect(
        configuration: NativeACPConnectionConfiguration,
        permissionHandler: @escaping NativeACPPermissionHandler = { _, _ in
            .object(["outcome": .object(["outcome": .string("cancelled")])])
        }
    ) async throws -> NativeACPConnection {
        let request = try webSocketRequest(configuration: configuration)
        let agent = configuration.agent
        guard agent.canConnectOverWebSocket else { throw NativeAgentsError.unsupportedTransport }
        let session = URLSession(configuration: .ephemeral)
        let socket = session.webSocketTask(with: request)
        socket.resume()
        let connection = NativeACPConnection(
            transport: NativeURLSessionACPTransport(socket: socket, session: session),
            permissionHandler: permissionHandler
        )
        await connection.startReceiving()
        do {
            let response = try await connection.request("initialize", params: .object([
                "protocolVersion": .number(1),
                "clientInfo": .object(["name": .string("thunderbolt"), "version": .string(appVersion)]),
                "clientCapabilities": .object([
                    "fs": .object(["readTextFile": .bool(false), "writeTextFile": .bool(false)]),
                    "terminal": .bool(false),
                ]),
            ]), timeout: .seconds(30))
            await connection.setCapabilities(from: response)
            return connection
        } catch {
            await connection.close()
            throw error
        }
    }

    static func webSocketRequest(configuration: NativeACPConnectionConfiguration) throws -> URLRequest {
        let agent = configuration.agent
        guard agent.canConnectOverWebSocket,
              let url = URL(string: agent.url), url.host != nil,
              url.scheme?.lowercased() == "wss", url.user == nil, url.password == nil else {
            if URL(string: agent.url)?.scheme?.lowercased() == "ws" { throw NativeACPError.insecureURL }
            throw NativeACPError.invalidURL
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.httpShouldHandleCookies = false
        if agent.type == .managed {
            guard let backendURL = configuration.backendURL,
                  Self.sameSecureOrigin(url, backendURL) else {
                throw NativeACPError.managedAgentOriginMismatch
            }
            var protocols = ["thunderbolt.v1"]
            if let token = configuration.sessionToken, !token.isEmpty {
                protocols.append("thunderbolt.bearer." + Self.base64URL(token))
            }
            request.setValue(protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol")
            request.setValue(configuration.deviceID?.nilIfBlank, forHTTPHeaderField: "X-Device-ID")
            request.setValue(configuration.appVersion?.nilIfBlank ?? Self.appVersion, forHTTPHeaderField: "X-App-Version")
        }
        return request
    }

    func newSession(skills: [NativeACPWireSkill] = []) async throws -> String {
        var params: [String: ChatJSONValue] = ["cwd": .string("."), "mcpServers": .array([])]
        if capabilities?.wireSkills == true { params["_meta"] = Self.skillsMetadata(skills) }
        let response = try await request("session/new", params: .object(params), timeout: .seconds(30))
        guard let sessionID = response["sessionId"]?.stringValue, !sessionID.isEmpty else {
            throw NativeACPError.invalidResponse("ACP agent did not return a session ID.")
        }
        return sessionID
    }

    /// Attempts resume, then load, then a new session, matching the Tauri ACP adapter.
    func restoreOrCreate(sessionID: String?, skills: [NativeACPWireSkill] = []) async throws -> NativeACPResolvedSession {
        guard let sessionID, !sessionID.isEmpty else {
            return NativeACPResolvedSession(sessionID: try await newSession(skills: skills), restored: false, created: true)
        }
        if capabilities?.resumeSession == true {
            do {
                _ = try await request("session/resume", params: sessionParams(sessionID, skills: skills), timeout: .seconds(30))
                return NativeACPResolvedSession(sessionID: sessionID, restored: true, created: false)
            } catch let error as NativeACPError where isRestoreRejection(error) {
            }
        }
        if capabilities?.loadSession == true {
            do {
                _ = try await request("session/load", params: sessionParams(sessionID, skills: skills), timeout: .seconds(30))
                return NativeACPResolvedSession(sessionID: sessionID, restored: true, created: false)
            } catch let error as NativeACPError where isRestoreRejection(error) {
            }
        }
        return NativeACPResolvedSession(sessionID: try await newSession(skills: skills), restored: false, created: true)
    }

    func prompt(sessionID: String, text: String) async throws -> String? {
        try await prompt(sessionID: sessionID, content: [
            .object(["type": .string("text"), "text": .string(text)]),
        ])
    }

    func prompt(sessionID: String, content: [ChatJSONValue]) async throws -> String? {
        let response = try await request("session/prompt", params: .object([
            "sessionId": .string(sessionID),
            "prompt": .array(content),
        ]))
        return response["stopReason"]?.stringValue
    }

    func cancel(sessionID: String) async throws {
        let pendingIDs = pending.compactMap { id, request in
            request.method == "session/prompt" && request.sessionID == sessionID ? id : nil
        }
        for id in pendingIDs {
            if let request = pending.removeValue(forKey: id) {
                request.timeout?.cancel()
                request.continuation.resume(throwing: CancellationError())
            }
        }
        try await notify("session/cancel", params: .object(["sessionId": .string(sessionID)]))
    }

    func setSessionConfigOption(sessionID: String, configID: String, value: String) async throws -> ChatJSONValue {
        try await request("session/set_config_option", params: .object([
            "sessionId": .string(sessionID), "configId": .string(configID), "value": .string(value),
        ]))
    }

    func close() async {
        guard !closed else { return }
        closed = true
        receiver?.cancel()
        receiver = nil
        let requests = Array(pending.values)
        pending.removeAll()
        for request in requests {
            request.timeout?.cancel()
            request.continuation.resume(throwing: NativeACPError.closed)
        }
        await transport.close()
        eventContinuation?.finish()
        eventContinuation = nil
    }

    private func request(_ method: String, params: ChatJSONValue, timeout: Duration? = nil) async throws -> ChatJSONValue {
        guard !closed else { throw NativeACPError.closed }
        let requestID = nextRequestID
        nextRequestID += 1
        let message = ChatJSONValue.object([
            "jsonrpc": .string("2.0"), "id": .number(Double(requestID)),
            "method": .string(method), "params": params,
        ])
        return try await withCheckedThrowingContinuation { continuation in
            let timeoutTask = timeout.map { duration in
                Task {
                    do { try await Task.sleep(for: duration) } catch { return }
                    failRequest(requestID, error: NativeACPError.timeout)
                }
            }
            pending[requestID] = PendingRequest(
                continuation: continuation, timeout: timeoutTask,
                method: method, sessionID: params["sessionId"]?.stringValue
            )
            Task {
                do { try await transport.send(message) }
                catch { failRequest(requestID, error: error) }
            }
        }
    }

    private func notify(_ method: String, params: ChatJSONValue) async throws {
        guard !closed else { throw NativeACPError.closed }
        try await transport.send(.object([
            "jsonrpc": .string("2.0"), "method": .string(method), "params": params,
        ]))
    }

    private func receiveLoop() async {
        do {
            while !Task.isCancelled && !closed {
                await handle(try await transport.receive())
            }
        } catch is CancellationError {
        } catch {
            await failConnection(error)
        }
    }

    private func handle(_ message: ChatJSONValue) async {
        guard let object = message.objectValue else { return }
        if let id = object["id"], let method = object["method"]?.stringValue {
            await handleAgentRequest(id: id, method: method, params: object["params"] ?? .object([:]))
            return
        }
        if let id = object["id"], let number = Self.integerID(id),
           let request = pending.removeValue(forKey: number) {
            request.timeout?.cancel()
            if let error = object["error"] {
                request.continuation.resume(throwing: NativeACPError.rpc(
                    code: Self.integerID(error["code"] ?? .number(-1)) ?? -1,
                    message: error["message"]?.stringValue ?? nativeString("ACP request failed.")))
            } else {
                request.continuation.resume(returning: object["result"] ?? .object([:]))
            }
            return
        }
        guard object["method"]?.stringValue == "session/update",
              let params = object["params"], let sessionID = params["sessionId"]?.stringValue,
              let update = params["update"] else { return }
        eventContinuation?.yield(.sessionUpdate(sessionID: sessionID, update: update))
    }

    private func handleAgentRequest(id: ChatJSONValue, method: String, params: ChatJSONValue) async {
        // Tauri's safe default cancels permissions unless a user-facing approval
        // handler is explicitly connected by the chat runtime.
        if method == "session/request_permission" {
            let sessionID = params["sessionId"]?.stringValue ?? ""
            eventContinuation?.yield(.permissionRequest(requestID: id, sessionID: sessionID, request: params))
            let result = await permissionHandler(sessionID, params)
            try? await transport.send(.object([
                "jsonrpc": .string("2.0"), "id": id,
                "result": result,
            ]))
        } else {
            try? await transport.send(.object([
                "jsonrpc": .string("2.0"), "id": id,
                "error": .object(["code": .number(-32601), "message": .string("Method not found")]),
            ]))
        }
    }

    private func setCapabilities(from response: ChatJSONValue) {
        let capabilities = response["agentCapabilities"]
        self.capabilities = NativeACPCapabilities(
            loadSession: capabilities?["loadSession"]?.boolValue ?? false,
            resumeSession: capabilities?["sessionCapabilities"]?["resume"] != nil
                && capabilities?["sessionCapabilities"]?["resume"] != .null,
            wireSkills: capabilities?["_meta"]?["thunderbird.net/thunderbolt"]?["skills"]?.boolValue == true,
            promptCapabilities: capabilities?["promptCapabilities"]
        )
    }

    private static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.164"
    }

    private static func base64URL(_ value: String) -> String {
        Data(value.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func sameSecureOrigin(_ socketURL: URL, _ backendURL: URL) -> Bool {
        guard socketURL.scheme?.lowercased() == "wss",
              backendURL.scheme?.lowercased() == "https",
              socketURL.host?.lowercased() == backendURL.host?.lowercased() else { return false }
        let socketPort = socketURL.port ?? 443
        let backendPort = backendURL.port ?? 443
        return socketPort == backendPort
    }

    private func sessionParams(_ sessionID: String, skills: [NativeACPWireSkill]) -> ChatJSONValue {
        var params: [String: ChatJSONValue] = ["sessionId": .string(sessionID), "cwd": .string("."), "mcpServers": .array([])]
        if capabilities?.wireSkills == true { params["_meta"] = Self.skillsMetadata(skills) }
        return .object(params)
    }

    private func isRestoreRejection(_ error: NativeACPError) -> Bool {
        if case .rpc = error { return true }
        return false
    }

    private static func skillsMetadata(_ skills: [NativeACPWireSkill]) -> ChatJSONValue {
        .object(["thunderbird.net/thunderbolt": .object([
            "skills": .array(skills.map { .object([
                "name": .string($0.name), "description": .string($0.description), "instruction": .string($0.instruction),
            ]) }),
        ])])
    }

    private nonisolated static func integerID(_ value: ChatJSONValue) -> Int? {
        switch value {
        case .number(let number) where number.rounded() == number: Int(exactly: number)
        case .string(let string): Int(string)
        default: nil
        }
    }

    private func failRequest(_ requestID: Int, error: Error) {
        pending.removeValue(forKey: requestID)?.continuation.resume(throwing: error)
    }

    private func failConnection(_ error: Error) async {
        guard !closed else { return }
        closed = true
        let requests = Array(pending.values)
        pending.removeAll()
        for request in requests {
            request.timeout?.cancel()
            request.continuation.resume(throwing: error)
        }
        eventContinuation?.yield(.connectionClosed(error.localizedDescription))
        eventContinuation?.finish()
        eventContinuation = nil
        await transport.close()
    }
}
