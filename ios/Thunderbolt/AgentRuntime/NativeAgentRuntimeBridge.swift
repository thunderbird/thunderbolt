/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import CryptoKit
import Foundation
import JavaScriptCore
import Security

@objc protocol NativeAgentRuntimeExports: JSExport {
    func loadWorkspace(_ threadID: String) -> String?
    func saveWorkspace(_ threadID: String, _ snapshotJSON: String) -> Bool
    func randomBytes(_ count: Int) -> String
    func randomUUID() -> String
    func scheduleTimer(_ timerID: String, _ delayMilliseconds: Double, _ callback: JSValue)
    func cancelTimer(_ timerID: String)
    func startFetch(
        _ requestID: String,
        _ requestJSON: String,
        _ onHeaders: JSValue,
        _ onChunk: JSValue,
        _ onComplete: JSValue
    )
    func cancelFetch(_ requestID: String)
    func executeNativeTool(_ requestID: String, _ threadID: String, _ name: String, _ argumentsJSON: String, _ callback: JSValue)
    func cancelNativeTool(_ requestID: String)
    func completeHarness(_ requestID: String, _ harnessID: String, _ error: String)
    func completePreparation(_ requestID: String, _ json: String, _ error: String)
    func completeShutdown(_ requestID: String, _ error: String)
    func appendStreamChunk(_ requestID: String, _ chunk: String)
    func completeStream(_ requestID: String, _ error: String)
}

private struct NativeFetchRequest: Decodable {
    let url: String
    let method: String
    let headers: [[String]]
    let body: String?
}

private final class NativeFetchCallbacks {
    let onHeaders: JSValue
    let onChunk: JSValue
    let onComplete: JSValue

    init(onHeaders: JSValue, onChunk: JSValue, onComplete: JSValue) {
        self.onHeaders = onHeaders
        self.onChunk = onChunk
        self.onComplete = onComplete
    }
}

private struct RegisteredModelTransport {
    let registration: NativeProviderTransportRegistration
    let origin: String
    let path: String
}

/// Durable workspaces are partitioned by canonical server, account, and thread hashes.
final class NativeAgentWorkspaceStore {
    private let root: URL
    private let ownerDirectory: URL
    private let lock = NSLock()

    init(serverURL: URL, userID: String, root: URL = .applicationSupportDirectory) {
        self.root = root.appending(path: "AgentWorkspaces", directoryHint: .isDirectory)
        let owner = "\(serverURL.absoluteString)\n\(userID)"
        let digest = SHA256.hash(data: Data(owner.utf8)).map { String(format: "%02x", $0) }.joined()
        ownerDirectory = self.root.appending(path: digest, directoryHint: .isDirectory)
    }

    static func removeAccount(serverURL: URL, userID: String, root: URL = .applicationSupportDirectory) throws {
        let directory = root.appending(path: "AgentWorkspaces", directoryHint: .isDirectory)
        let owner = "\(serverURL.absoluteString)\n\(userID)"
        let digest = SHA256.hash(data: Data(owner.utf8)).map { String(format: "%02x", $0) }.joined()
        let accountDirectory = directory.appending(path: digest, directoryHint: .isDirectory)
        guard FileManager.default.fileExists(atPath: accountDirectory.path) else { return }
        try FileManager.default.removeItem(at: accountDirectory)
    }

    func load(threadID: String) -> String? {
        guard let url = fileURL(threadID: threadID) else { return nil }
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            let values = try url.resourceValues(forKeys: [.fileSizeKey])
            guard let size = values.fileSize, size <= 96 * 1024 * 1024,
                  let data = try? Data(contentsOf: url),
                  let contents = String(data: data, encoding: .utf8) else { return "" }
            return contents
        } catch {
            return ""
        }
    }

    func save(threadID: String, json: String) -> Bool {
        guard let url = fileURL(threadID: threadID) else { return false }
        let data = Data(json.utf8)
        guard data.count <= 96 * 1024 * 1024 else { return false }
        lock.lock()
        defer { lock.unlock() }
        do {
            try FileManager.default.createDirectory(at: ownerDirectory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var directory = ownerDirectory
            try directory.setResourceValues(values)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            return true
        } catch {
            return false
        }
    }

    private func fileURL(threadID: String) -> URL? {
        guard !threadID.isEmpty, threadID.count <= 160,
              threadID.range(of: #"^[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil,
              threadID != ".", threadID != ".." else { return nil }
        let digest = SHA256.hash(data: Data(threadID.utf8)).map { String(format: "%02x", $0) }.joined()
        return ownerDirectory.appending(path: "\(digest).json")
    }
}

/// JSC host services: jailed workspace persistence, cryptographic randomness, timers, and streamed HTTP.
final class NativeAgentRuntimeBridge: NSObject, NativeAgentRuntimeExports, @unchecked Sendable {
    private let queue: DispatchQueue
    private let workspaceStore: NativeAgentWorkspaceStore
    private let confidentialInference: (any NativeConfidentialInferenceHandling)?
    private let userTinfoilInference: (any NativeConfidentialInferenceHandling)?
    private let localToolHandler: (any NativeLocalToolHandling)?
    private var modelTransports: [String: RegisteredModelTransport] = [:]
    private weak var runtime: PiAgentRuntime?
    private var timers: [String: DispatchWorkItem] = [:]
    private var callbacks: [String: NativeFetchCallbacks] = [:]
    private var confidentialTasks: [String: any NativeConfidentialInferenceTask] = [:]
    private var sessions: [String: URLSession] = [:]
    private var tasks: [String: URLSessionDataTask] = [:]
    private var localToolCallbacks: [String: JSValue] = [:]
    private var localToolTasks: [String: Task<Void, Never>] = [:]

    init(
        queue: DispatchQueue,
        serverURL: URL,
        userID: String,
        runtime: PiAgentRuntime,
        confidentialInference: (any NativeConfidentialInferenceHandling)? = nil,
        userTinfoilInference: (any NativeConfidentialInferenceHandling)? = nil,
        localToolHandler: (any NativeLocalToolHandling)? = nil
    ) {
        self.queue = queue
        workspaceStore = NativeAgentWorkspaceStore(serverURL: serverURL, userID: userID)
        self.confidentialInference = confidentialInference
        self.userTinfoilInference = userTinfoilInference
        self.localToolHandler = localToolHandler
        backendOrigin = Self.origin(serverURL)
        self.runtime = runtime
        super.init()
    }

    private let backendOrigin: String?

    func loadWorkspace(_ threadID: String) -> String? {
        workspaceStore.load(threadID: threadID)
    }

    func saveWorkspace(_ threadID: String, _ snapshotJSON: String) -> Bool {
        workspaceStore.save(threadID: threadID, json: snapshotJSON)
    }

    func randomBytes(_ count: Int) -> String {
        guard count >= 0, count <= 65_536 else { return "!" }
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { return "!" }
        return Data(bytes).base64EncodedString()
    }

    func randomUUID() -> String { UUID().uuidString.lowercased() }

    func scheduleTimer(_ timerID: String, _ delayMilliseconds: Double, _ callback: JSValue) {
        timers[timerID]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.timers.removeValue(forKey: timerID)
            callback.call(withArguments: [])
        }
        timers[timerID] = work
        queue.asyncAfter(deadline: .now() + max(0, delayMilliseconds) / 1000, execute: work)
    }

    func cancelTimer(_ timerID: String) {
        timers.removeValue(forKey: timerID)?.cancel()
    }

    func startFetch(
        _ requestID: String,
        _ requestJSON: String,
        _ onHeaders: JSValue,
        _ onChunk: JSValue,
        _ onComplete: JSValue
    ) {
        guard let data = requestJSON.data(using: .utf8),
              let request = try? JSONDecoder().decode(NativeFetchRequest.self, from: data),
              let url = URL(string: request.url) else {
            onComplete.call(withArguments: ["Request URL is not allowed by the native runtime"])
            return
        }
        var headers = Dictionary(request.headers.compactMap { header -> (String, String)? in
            guard header.count == 2 else { return nil }
            return (header[0].lowercased(), header[1])
        }, uniquingKeysWith: { _, latest in latest })
        let transportID = headers.removeValue(forKey: NativePiModelDescriptor.transportRegistrationHeader.lowercased())
        let registration = transportID.flatMap { modelTransports[$0] }
        guard transportID == nil || registration != nil,
              isAllowed(url, registration: registration) else {
            onComplete.call(withArguments: ["Request URL is not allowed by the native runtime"])
            return
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        if registration?.registration.kind == .customNoAuth {
            headers.removeValue(forKey: "authorization")
        }
        for (name, value) in headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        if let body = request.body {
            guard let bodyData = Data(base64Encoded: body) else {
                onComplete.call(withArguments: ["Request body is invalid"])
                return
            }
            urlRequest.httpBody = bodyData
        }
        callbacks[requestID] = NativeFetchCallbacks(onHeaders: onHeaders, onChunk: onChunk, onComplete: onComplete)
        if registration?.registration.kind == .tinfoilUser {
            guard let userTinfoilInference else {
                enqueueImmediateError(requestID: requestID, message: "The native Tinfoil transport is unavailable")
                return
            }
            let inferenceRequest = NativeConfidentialInferenceRequest(
                url: url,
                method: request.method,
                headers: headers,
                body: urlRequest.httpBody,
                transportID: transportID
            )
            confidentialTasks[requestID] = userTinfoilInference.start(
                request: inferenceRequest,
                onHeaders: { [weak self] status, headers in self?.enqueueHeaders(requestID: requestID, status: status, headers: headers) },
                onChunk: { [weak self] data in self?.enqueueChunk(requestID: requestID, data: data) },
                onComplete: { [weak self] error in self?.enqueueComplete(requestID: requestID, error: error) }
            )
            return
        }
        if Self.isManagedTinfoilEndpoint(url) {
            guard registration == nil, let confidentialInference else {
                enqueueImmediateError(requestID: requestID, message: "The managed Tinfoil transport is unavailable")
                return
            }
            let inferenceRequest = NativeConfidentialInferenceRequest(
                url: url,
                method: request.method,
                headers: headers,
                body: urlRequest.httpBody
            )
            confidentialTasks[requestID] = confidentialInference.start(
                request: inferenceRequest,
                onHeaders: { [weak self] status, headers in self?.enqueueHeaders(requestID: requestID, status: status, headers: headers) },
                onChunk: { [weak self] data in self?.enqueueChunk(requestID: requestID, data: data) },
                onComplete: { [weak self] error in self?.enqueueComplete(requestID: requestID, error: error) }
            )
            return
        }
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        urlRequest.httpShouldHandleCookies = false
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let delegate = NativeFetchDelegate(bridge: self, requestID: requestID, originalURL: url, transportID: transportID)
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        sessions[requestID] = session
        let task: URLSessionDataTask = session.dataTask(with: urlRequest as URLRequest)
        task.taskDescription = requestID
        tasks[requestID] = task
        delegate.task = task
        task.resume()
    }

    func cancelFetch(_ requestID: String) {
        if let task = confidentialTasks.removeValue(forKey: requestID) {
            task.cancel()
            return
        }
        tasks[requestID]?.cancel()
    }

    func executeNativeTool(_ requestID: String, _ threadID: String, _ name: String, _ argumentsJSON: String, _ callback: JSValue) {
        guard let localToolHandler else {
            callback.call(withArguments: ["", "Native local tools are unavailable"])
            return
        }
        localToolCallbacks[requestID] = callback
        let task = Task { [weak self] in
            let result: Result<String, Error>
            do {
                result = .success(try await localToolHandler.execute(threadID: threadID, name: name, argumentsJSON: argumentsJSON))
            } catch {
                result = .failure(error)
            }
            self?.queue.async { [weak self] in
                self?.localToolTasks.removeValue(forKey: requestID)
                guard let callback = self?.localToolCallbacks.removeValue(forKey: requestID) else { return }
                switch result {
                case .success(let json): callback.call(withArguments: [json, ""])
                case .failure(let error): callback.call(withArguments: ["", error.localizedDescription])
                }
            }
        }
        localToolTasks[requestID] = task
    }

    func cancelNativeTool(_ requestID: String) {
        localToolTasks.removeValue(forKey: requestID)?.cancel()
        localToolCallbacks.removeValue(forKey: requestID)
    }

    func registerModelTransport(_ registration: NativeProviderTransportRegistration) -> Bool {
        guard let descriptor = Self.validatedRegistration(registration),
              descriptor.origin != backendOrigin,
              modelTransports[registration.id] == nil || modelTransports[registration.id]?.registration == registration else { return false }
        modelTransports[registration.id] = descriptor
        return true
    }

    func revokeModelTransport(_ id: String) {
        modelTransports.removeValue(forKey: id)
    }

    func revokeAllModelTransports() {
        modelTransports.removeAll()
    }

    func completeHarness(_ requestID: String, _ harnessID: String, _ error: String) {
        runtime?.completeHarness(requestID, harnessID: harnessID, error: error.isEmpty ? nil : error)
    }

    func completePreparation(_ requestID: String, _ json: String, _ error: String) {
        runtime?.completePreparation(requestID, json: json, error: error.isEmpty ? nil : error)
    }

    func completeShutdown(_ requestID: String, _ error: String) {
        runtime?.completeShutdown(requestID, error: error.isEmpty ? nil : error)
    }

    func appendStreamChunk(_ requestID: String, _ chunk: String) {
        runtime?.appendChunk(requestID, chunk: chunk)
    }

    func completeStream(_ requestID: String, _ error: String) {
        runtime?.completeStream(requestID, error: error.isEmpty ? nil : error)
    }

    fileprivate func enqueueHeaders(requestID: String, status: Int, headers: [String: String]) {
        let json = (try? JSONSerialization.data(withJSONObject: headers)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        queue.async { [weak self] in
            guard let callback = self?.callbacks[requestID]?.onHeaders else { return }
            callback.call(withArguments: [status, json])
        }
    }

    fileprivate func enqueueChunk(requestID: String, data: Data) {
        let base64 = data.base64EncodedString()
        queue.async { [weak self] in
            guard let callback = self?.callbacks[requestID]?.onChunk else { return }
            callback.call(withArguments: [base64])
        }
    }

    fileprivate func enqueueComplete(requestID: String, error: String?) {
        queue.async { [weak self] in
            guard let self else { return }
            let completionValue: Any = error ?? NSNull()
            self.callbacks.removeValue(forKey: requestID)?.onComplete.call(withArguments: [completionValue])
            self.confidentialTasks.removeValue(forKey: requestID)
            self.tasks.removeValue(forKey: requestID)
            self.sessions.removeValue(forKey: requestID)?.finishTasksAndInvalidate()
        }
    }

    fileprivate func isAllowedRedirect(_ url: URL, from originalURL: URL, transportID: String?) -> Bool {
        Self.origin(url) == Self.origin(originalURL) && isAllowed(url, registration: transportID.flatMap { modelTransports[$0] })
    }

    private func isAllowed(_ url: URL, registration: RegisteredModelTransport?) -> Bool {
        guard Self.hasSafeScheme(url) else { return false }
        guard let registration else { return Self.origin(url) == backendOrigin }
        return Self.origin(url) == registration.origin && Self.isWithin(path: url.path, basePath: registration.path)
    }

    private static func validatedRegistration(_ registration: NativeProviderTransportRegistration) -> RegisteredModelTransport? {
        guard UUID(uuidString: registration.id) != nil,
              let parts = URLComponents(url: registration.baseURL, resolvingAgainstBaseURL: false),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              let host = parts.host, !host.isEmpty, hasSafeScheme(registration.baseURL),
              origin(registration.baseURL) != nil else { return nil }
        let path = parts.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return RegisteredModelTransport(registration: registration, origin: origin(registration.baseURL)!, path: path)
    }

    private static func hasSafeScheme(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" || (url.scheme?.lowercased() == "http" && isLoopback(url.host))
    }

    private static func isWithin(path: String, basePath: String) -> Bool {
        let normalized = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return basePath.isEmpty || normalized == basePath || normalized.hasPrefix(basePath + "/")
    }

    private static func isManagedTinfoilEndpoint(_ url: URL) -> Bool {
        url.path.hasSuffix("/v1/tinfoil/chat/completions")
    }

    static func sameEndpoint(_ first: URL, _ second: URL) -> Bool {
        guard origin(first) == origin(second),
              let firstParts = URLComponents(url: first, resolvingAgainstBaseURL: false),
              let secondParts = URLComponents(url: second, resolvingAgainstBaseURL: false),
              firstParts.query == nil, firstParts.fragment == nil,
              secondParts.query == nil, secondParts.fragment == nil else { return false }
        let firstPath = firstParts.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let secondPath = secondParts.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return firstPath == secondPath
    }

    private func enqueueImmediateError(requestID: String, message: String) {
        guard let callbacks = self.callbacks.removeValue(forKey: requestID) else { return }
        let headers = "{\"content-type\":\"application/json\"}"
        let body = try? JSONSerialization.data(withJSONObject: ["error": message])
        callbacks.onHeaders.call(withArguments: [503, headers])
        if let body { callbacks.onChunk.call(withArguments: [body.base64EncodedString()]) }
        callbacks.onComplete.call(withArguments: [NSNull()])
    }

    private static func origin(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        let port = url.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }

    private static func isLoopback(_ host: String?) -> Bool {
        ["localhost", "127.0.0.1", "::1"].contains(host?.lowercased() ?? "")
    }
}

private final class NativeFetchDelegate: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let bridge: NativeAgentRuntimeBridge
    private let requestID: String
    private let originalURL: URL
    private let transportID: String?
    weak var task: URLSessionDataTask?

    init(bridge: NativeAgentRuntimeBridge, requestID: String, originalURL: URL, transportID: String?) {
        self.bridge = bridge
        self.requestID = requestID
        self.originalURL = originalURL
        self.transportID = transportID
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse else {
            bridge.enqueueComplete(requestID: requestID, error: "The model server returned an invalid response")
            completionHandler(.cancel)
            return
        }
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, item in
            guard let key = item.key as? String else { return }
            result[key] = String(describing: item.value)
        }
        bridge.enqueueHeaders(requestID: requestID, status: response.statusCode, headers: headers)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        bridge.enqueueChunk(requestID: requestID, data: data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, bridge.isAllowedRedirect(url, from: originalURL, transportID: transportID) else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        bridge.enqueueComplete(requestID: requestID, error: error?.localizedDescription)
    }
}
