/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

enum NativeMCPError: Error, LocalizedError, Equatable {
    case invalidURL
    case unsupportedTransport
    case http(Int, String)
    case protocolError(Int, String)
    case invalidResponse
    case timedOut

    var errorDescription: String? {
        switch self {
        case .invalidURL: nativeString("Enter a valid HTTPS MCP server URL.")
        case .unsupportedTransport: nativeString("This MCP transport is not available on iOS.")
        case .http(let status, let body): "MCP server returned HTTP \(status): \(body)"
        case .protocolError(let code, let message): "MCP error \(code): \(message)"
        case .invalidResponse: nativeString("The MCP server returned an invalid response.")
        case .timedOut: nativeString("The MCP server did not respond in time.")
        }
    }
}

struct NativeMCPTool: Codable, Equatable, Identifiable, Sendable {
    let name: String
    let title: String?
    let description: String?
    let inputSchema: ChatJSONValue

    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name, title, description
        case inputSchema = "inputSchema"
    }
}

struct NativeMCPToolResult: Codable, Equatable, Sendable {
    let content: [ChatJSONValue]?
    let structuredContent: ChatJSONValue?
    let isError: Bool?
}

private typealias NativeMCPRPC = (String, ChatJSONValue) async throws -> ChatJSONValue

/// Small MCP client for the two remote transports supported by Tauri on mobile.
/// Credentials are supplied per operation and never cached in the transport.
actor NativeMCPClient {
    private let session: URLSession
    private let clientName: String
    private let clientVersion: String

    init(session: URLSession? = nil, clientName: String = "Thunderbolt", clientVersion: String? = nil) {
        self.session = session ?? Self.makeSession()
        self.clientName = clientName
        self.clientVersion = clientVersion ?? Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.164"
    }

    func listTools(serverURL: URL, transport: String, bearerToken: String?) async throws -> [NativeMCPTool] {
        let result = try await withSession(serverURL: serverURL, transport: transport, bearerToken: bearerToken) { rpc in
            var tools: [NativeMCPTool] = []
            var cursor: String?
            repeat {
                var params: [String: ChatJSONValue] = [:]
                if let cursor { params["cursor"] = .string(cursor) }
                let result = try await rpc("tools/list", .object(params))
                guard case .object(let resultObject) = result,
                      case .array(let page)? = resultObject["tools"] else { throw NativeMCPError.invalidResponse }
                tools += try page.map { try JSONDecoder().decode(NativeMCPTool.self, from: JSONEncoder().encode($0)) }
                cursor = resultObject["nextCursor"]?.stringValue
            } while cursor != nil
            return .array(try tools.map { try JSONDecoder().decode(ChatJSONValue.self, from: JSONEncoder().encode($0)) })
        }
        guard case .array(let values) = result else { throw NativeMCPError.invalidResponse }
        return try values.map { try JSONDecoder().decode(NativeMCPTool.self, from: JSONEncoder().encode($0)) }
    }

    func callTool(
        serverURL: URL,
        transport: String,
        bearerToken: String?,
        name: String,
        arguments: [String: ChatJSONValue]
    ) async throws -> NativeMCPToolResult {
        let result = try await withSession(serverURL: serverURL, transport: transport, bearerToken: bearerToken) { rpc in
            try await rpc("tools/call", .object(["name": .string(name), "arguments": .object(arguments)]))
        }
        return try JSONDecoder().decode(NativeMCPToolResult.self, from: JSONEncoder().encode(result))
    }

    private func withSession(
        serverURL: URL,
        transport: String,
        bearerToken: String?,
        operation: (NativeMCPRPC) async throws -> ChatJSONValue
    ) async throws -> ChatJSONValue {
        switch transport {
        case "http":
            try Self.validate(serverURL)
            return try await withStreamableSession(serverURL, bearerToken: bearerToken, operation: operation)
        case "sse":
            try Self.validate(serverURL)
            return try await withLegacySSESession(serverURL, bearerToken: bearerToken, operation: operation)
        default:
            throw NativeMCPError.unsupportedTransport
        }
    }

    private func withStreamableSession(
        _ url: URL,
        bearerToken: String?,
        operation: (NativeMCPRPC) async throws -> ChatJSONValue
    ) async throws -> ChatJSONValue {
        let sessionID = MCPResponseState()
        var nextID = 1
        var protocolVersion = "2025-03-26"
        let rpc: NativeMCPRPC = { [self] method, params in
            let id = nextID
            nextID += 1
            let request = Self.rpcRequest(id: .number(Double(id)), method: method, params: params)
            let (data, response) = try await post(request, to: url, bearerToken: bearerToken,
                sessionID: await sessionID.value, protocolVersion: protocolVersion)
            guard response.statusCode == 200 else { throw Self.httpError(response.statusCode, data) }
            let result = try Self.responseResult(data, id: .number(Double(id)))
            if let header = response.value(forHTTPHeaderField: "Mcp-Session-Id") { await sessionID.set(header) }
            if method == "initialize", let negotiated = result["protocolVersion"]?.stringValue {
                protocolVersion = negotiated
            }
            return result
        }

        do {
            _ = try await rpc("initialize", .object([
                "protocolVersion": .string(protocolVersion),
                "capabilities": .object([:]),
                "clientInfo": .object(["name": .string(clientName), "version": .string(clientVersion)]),
            ]))
            let initialized = Self.rpcNotification(method: "notifications/initialized")
            let (_, initializedResponse) = try await post(initialized, to: url, bearerToken: bearerToken,
                sessionID: await sessionID.value, protocolVersion: protocolVersion)
            guard (200..<300).contains(initializedResponse.statusCode) else {
                throw NativeMCPError.http(initializedResponse.statusCode, "initialization notification failed")
            }
            let result = try await operation(rpc)
            if let id = await sessionID.value {
                var request = URLRequest(url: url)
                request.httpMethod = "DELETE"
                request.setValue(id, forHTTPHeaderField: "Mcp-Session-Id")
                if let bearerToken { request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization") }
                _ = try? await session.data(for: request)
            }
            return result
        } catch {
            if let id = await sessionID.value {
                var request = URLRequest(url: url)
                request.httpMethod = "DELETE"
                request.setValue(id, forHTTPHeaderField: "Mcp-Session-Id")
                if let bearerToken { request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization") }
                _ = try? await session.data(for: request)
            }
            throw error
        }
    }

    private func withLegacySSESession(
        _ url: URL,
        bearerToken: String?,
        operation: (NativeMCPRPC) async throws -> ChatJSONValue
    ) async throws -> ChatJSONValue {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if let bearerToken { request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization") }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw NativeMCPError.http((response as? HTTPURLResponse)?.statusCode ?? 0, "could not open MCP event stream")
        }
        let inbox = NativeMCPSSEInbox(endpointBaseURL: url)
        let reader = Task {
            var event = "message"
            var dataLines: [String] = []
            do {
                for try await line in bytes.lines {
                    if line.isEmpty {
                        await inbox.receive(event: event, data: dataLines.joined(separator: "\n"))
                        event = "message"
                        dataLines = []
                    } else if line.hasPrefix("event:") {
                        event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                    } else if line.hasPrefix("data:") {
                        dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                    }
                }
                await inbox.fail(NativeMCPError.invalidResponse)
            } catch { await inbox.fail(error) }
        }
        defer { reader.cancel() }
        let endpoint = try await inbox.waitForEndpoint()
        try Self.validate(endpoint)
        guard Self.sameOrigin(endpoint, url) else { throw NativeMCPError.invalidURL }
        var id = 1
        var protocolVersion = "2025-03-26"
        let rpc: NativeMCPRPC = { method, params in
            let requestID = id
            id += 1
            let wireID = ChatJSONValue.number(Double(requestID))
            let body = Self.encoded(Self.rpcRequest(id: wireID, method: method, params: params))
            var postRequest = URLRequest(url: endpoint)
            postRequest.httpMethod = "POST"
            postRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            postRequest.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
            postRequest.setValue(protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version")
            if let bearerToken { postRequest.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization") }
            postRequest.httpBody = body
            let (postData, postResponse) = try await self.session.data(for: postRequest)
            guard let postHTTP = postResponse as? HTTPURLResponse, (200..<300).contains(postHTTP.statusCode) else {
                throw Self.httpError((postResponse as? HTTPURLResponse)?.statusCode ?? 0, postData)
            }
            if !postData.isEmpty, let responseResult = try? Self.responseResult(postData, id: wireID) {
                return responseResult
            }
            let responseValue = try await inbox.waitForResponse(id: requestID)
            if method == "initialize", let negotiated = responseValue["protocolVersion"]?.stringValue {
                protocolVersion = negotiated
            }
            return responseValue
        }

        _ = try await rpc("initialize", .object([
            "protocolVersion": .string(protocolVersion), "capabilities": .object([:]),
            "clientInfo": .object(["name": .string(clientName), "version": .string(clientVersion)]),
        ]))
        let notify = Self.encoded(Self.rpcNotification(method: "notifications/initialized"))
        var notifyRequest = URLRequest(url: endpoint)
        notifyRequest.httpMethod = "POST"
        notifyRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        notifyRequest.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        notifyRequest.setValue(protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version")
        if let bearerToken { notifyRequest.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization") }
        notifyRequest.httpBody = notify
        _ = try await session.data(for: notifyRequest)
        return try await operation(rpc)
    }

    private func post(_ body: ChatJSONValue, to url: URL, bearerToken: String?, sessionID: String?, protocolVersion: String?) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let bearerToken { request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization") }
        if let sessionID { request.setValue(sessionID, forHTTPHeaderField: "Mcp-Session-Id") }
        if let protocolVersion { request.setValue(protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version") }
        request.httpBody = Self.encoded(body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw NativeMCPError.invalidResponse }
        return (data, http)
    }

    nonisolated static func validate(_ url: URL) throws {
        guard let scheme = url.scheme?.lowercased(), let host = url.host,
              url.user == nil, url.password == nil, url.fragment == nil,
              (scheme == "https" || (scheme == "http" && Self.isLocalOrPrivate(host))) else {
            throw NativeMCPError.invalidURL
        }
    }

    nonisolated private static func isLocalOrPrivate(_ host: String) -> Bool {
        let value = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        if value == "localhost" || value.hasSuffix(".localhost") || value == "::1" { return true }
        if value.contains(":"), let first = value.split(separator: ":").first {
            return first.hasPrefix("fc") || first.hasPrefix("fd")
        }
        let parts = value.split(separator: ".").compactMap { UInt8($0) }
        guard parts.count == 4 else { return false }
        return parts[0] == 127 || parts[0] == 10 ||
            (parts[0] == 172 && (16...31).contains(parts[1])) ||
            (parts[0] == 192 && parts[1] == 168)
    }

    nonisolated private static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        let defaultPort: (String?) -> Int? = { scheme in
            switch scheme?.lowercased() { case "https": 443; case "http": 80; default: nil }
        }
        return lhs.scheme?.lowercased() == rhs.scheme?.lowercased() &&
            lhs.host?.lowercased() == rhs.host?.lowercased() &&
            (lhs.port ?? defaultPort(lhs.scheme)) == (rhs.port ?? defaultPort(rhs.scheme)) &&
            lhs.user == nil && lhs.password == nil && lhs.fragment == nil
    }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: NativeMCPNoRedirectDelegate(), delegateQueue: nil)
    }

    private static func rpcRequest(id: ChatJSONValue, method: String, params: ChatJSONValue) -> ChatJSONValue {
        .object(["jsonrpc": .string("2.0"), "id": id, "method": .string(method), "params": params])
    }

    private static func rpcNotification(method: String) -> ChatJSONValue {
        .object(["jsonrpc": .string("2.0"), "method": .string(method)])
    }

    private static func encoded(_ value: ChatJSONValue) -> Data { (try? JSONEncoder().encode(value)) ?? Data() }

    private static func decodeResult(_ data: Data) -> [String: ChatJSONValue] {
        (try? JSONDecoder().decode(ChatJSONValue.self, from: data))?.objectValue?["result"]?.objectValue ?? [:]
    }

    private static func responseResult(_ data: Data, id: ChatJSONValue) throws -> ChatJSONValue {
        let messages: [ChatJSONValue]
        if let value = try? JSONDecoder().decode(ChatJSONValue.self, from: data) {
            messages = [value]
        } else if let text = String(data: data, encoding: .utf8) {
            messages = try text.components(separatedBy: "\n\n").compactMap { frame in
                let payload = frame.split(separator: "\n").compactMap { line -> String? in
                    guard line.hasPrefix("data:") else { return nil }
                    return String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                }.joined(separator: "\n")
                guard !payload.isEmpty else { return nil }
                return try JSONDecoder().decode(ChatJSONValue.self, from: Data(payload.utf8))
            }
        } else { throw NativeMCPError.invalidResponse }
        for message in messages {
            guard let object = message.objectValue else { continue }
            if object["id"] == id, let result = object["result"] { return result }
            if object["id"] == id, case .object(let error)? = object["error"] {
                let code = Int(error["code"]?.numberValue ?? -1)
                throw NativeMCPError.protocolError(code, error["message"]?.stringValue ?? "request failed")
            }
        }
        throw NativeMCPError.invalidResponse
    }

    private static func httpError(_ status: Int, _ data: Data) -> NativeMCPError {
        let body = String(data: data.prefix(512), encoding: .utf8) ?? ""
        return .http(status, body)
    }
}

final class NativeMCPNoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

private actor MCPResponseState {
    private(set) var value: String?
    func set(_ value: String) { self.value = value }
}

private actor NativeMCPSSEInbox {
    private var endpoint: URL?
    private var endpointWaiter: CheckedContinuation<URL, Error>?
    private var responses: [Int: ChatJSONValue] = [:]
    private var responseWaiters: [Int: CheckedContinuation<ChatJSONValue, Error>] = [:]
    private var terminalError: Error?
    private let endpointBaseURL: URL

    init(endpointBaseURL: URL) { self.endpointBaseURL = endpointBaseURL }

    func receive(event: String, data: String) {
        if event == "endpoint" {
            guard let relative = URL(string: data.trimmingCharacters(in: .whitespacesAndNewlines), relativeTo: endpointBaseURL) else {
                fail(NativeMCPError.invalidURL); return
            }
            endpoint = relative.absoluteURL
            endpointWaiter?.resume(returning: relative.absoluteURL)
            endpointWaiter = nil
            return
        }
        guard let payload = data.data(using: .utf8),
              let value = try? JSONDecoder().decode(ChatJSONValue.self, from: payload),
              let object = value.objectValue,
              let id = object["id"]?.numberValue.map(Int.init) else { return }
        if let waiter = responseWaiters.removeValue(forKey: id) { waiter.resume(returning: value) }
        else { responses[id] = value }
    }

    func waitForEndpoint() async throws -> URL {
        if let endpoint { return endpoint }
        if let terminalError { throw terminalError }
        return try await withCheckedThrowingContinuation { endpointWaiter = $0 }
    }

    func waitForResponse(id: Int) async throws -> ChatJSONValue {
        if let response = responses.removeValue(forKey: id) { return try Self.result(response) }
        if let terminalError { throw terminalError }
        let response = try await withCheckedThrowingContinuation { responseWaiters[id] = $0 }
        return try Self.result(response)
    }

    func fail(_ error: Error) {
        terminalError = error
        endpointWaiter?.resume(throwing: error)
        endpointWaiter = nil
        for waiter in responseWaiters.values { waiter.resume(throwing: error) }
        responseWaiters.removeAll()
    }

    private static func result(_ value: ChatJSONValue) throws -> ChatJSONValue {
        guard let object = value.objectValue else { throw NativeMCPError.invalidResponse }
        if case .object(let error)? = object["error"] {
            throw NativeMCPError.protocolError(Int(error["code"]?.numberValue ?? -1), error["message"]?.stringValue ?? "request failed")
        }
        guard let result = object["result"] else { throw NativeMCPError.invalidResponse }
        return result
    }
}
