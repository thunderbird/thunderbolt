/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import JavaScriptCore

private final class PiRuntimeBundleMarker {}

struct PiRuntimeFailure: LocalizedError, Sendable {
    let message: String
    var errorDescription: String? { message }
}

/// Runs the shared Pi `buildAppHarness` bundle inside an isolated JavaScriptCore context.
final class PiAgentRuntime: @unchecked Sendable {
    private let queue = DispatchQueue(label: "net.thunderbird.thunderbolt.pi-runtime", qos: .userInitiated)
    private let serverURL: URL
    private let userID: String
    private let context: JSContext
    private var bridge: NativeAgentRuntimeBridge?
    private var scriptError: String?
    private var harnessCompletions: [String: @Sendable (Result<String, PiRuntimeFailure>) -> Void] = [:]
    private var pendingTransportRegistrations: [String: String] = [:]
    private var harnessTransportRegistrations: [String: String] = [:]
    private var preparationCompletions: [String: @Sendable (Result<String, PiRuntimeFailure>) -> Void] = [:]
    private var compactionTransportRegistrations: [String: String] = [:]
    private var activeCompactionRequests = Set<String>()
    private var cancelledCompactions = Set<String>()
    private var shutdownCompletions: [String: @Sendable (Result<Void, PiRuntimeFailure>) -> Void] = [:]
    private var streamCallbacks: [String: StreamCallbacks] = [:]

    private struct StreamCallbacks {
        let onChunk: @Sendable (String) -> Void
        let onComplete: @Sendable (PiRuntimeFailure?) -> Void
    }

    init(
        serverURL: URL,
        userID: String,
        confidentialInference: (any NativeConfidentialInferenceHandling)? = nil,
        userTinfoilInference: (any NativeConfidentialInferenceHandling)? = nil,
        localToolHandler: (any NativeLocalToolHandling)? = nil
    ) throws {
        self.serverURL = serverURL
        self.userID = userID
        guard let context = JSContext() else {
            throw PiRuntimeFailure(message: "JavaScriptCore could not be initialized")
        }
        self.context = context
        queue.sync {
            bridge = NativeAgentRuntimeBridge(
                queue: queue,
                serverURL: serverURL,
                userID: userID,
                runtime: self,
                confidentialInference: confidentialInference,
                userTinfoilInference: userTinfoilInference,
                localToolHandler: localToolHandler
            )
            context.exceptionHandler = { [weak self] _, exception in
                self?.scriptError = exception?.toString()
            }
            context.setObject(bridge, forKeyedSubscript: "__thunderboltNative" as NSString)
            let bundle = Bundle(for: PiRuntimeBundleMarker.self)
            guard let preludeURL = bundle.url(forResource: "jsc-prelude", withExtension: "js", subdirectory: "AgentRuntime")
                ?? bundle.url(forResource: "jsc-prelude", withExtension: "js"),
                  let prelude = try? String(contentsOf: preludeURL, encoding: .utf8),
                  let scriptURL = bundle.url(forResource: "agent-runtime", withExtension: "js", subdirectory: "AgentRuntime")
                ?? bundle.url(forResource: "agent-runtime", withExtension: "js"),
                  let script = try? String(contentsOf: scriptURL, encoding: .utf8) else {
                scriptError = "The bundled Pi runtime files were not found"
                return
            }
            context.evaluateScript(prelude)
            context.evaluateScript(script)
            if context.objectForKeyedSubscript("__thunderboltPiRuntime")?.isUndefined != false {
                scriptError = scriptError ?? "The bundled Pi runtime did not initialize"
            }
        }
        if let scriptError { throw PiRuntimeFailure(message: scriptError) }
    }

    /// Resolves native model reasoning controls through the same Pi catalog and shared preference helpers as Tauri.
    func resolveReasoning(
        provider: String,
        modelID: String,
        savedEffort: String?,
        profileOptionsJSON: String?,
        capabilitiesJSON: String? = nil
    ) async throws -> String {
        let options: [String: Any] = [
            "savedEffort": savedEffort.map { $0 as Any } ?? NSNull(),
            "profileOptionsJSON": profileOptionsJSON.map { $0 as Any } ?? NSNull(),
            "capabilitiesJSON": capabilitiesJSON.map { $0 as Any } ?? NSNull(),
        ]
        let data = try JSONSerialization.data(withJSONObject: options, options: [.sortedKeys])
        guard let optionsJSON = String(data: data, encoding: .utf8) else {
            throw PiRuntimeFailure(message: "Could not encode reasoning preferences")
        }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            queue.async { [weak self] in
                guard let self else {
                    continuation.resume(throwing: PiRuntimeFailure(message: "The Pi runtime is unavailable"))
                    return
                }
                scriptError = nil
                let result = runtimeObject()?.invokeMethod("resolveReasoning", withArguments: [provider, modelID, optionsJSON])
                if let scriptError {
                    continuation.resume(throwing: PiRuntimeFailure(message: scriptError))
                    return
                }
                guard let result, !result.isUndefined, !result.isNull, let json = result.toString() else {
                    continuation.resume(throwing: PiRuntimeFailure(message: "The Pi runtime returned no reasoning result"))
                    return
                }
                continuation.resume(returning: json)
            }
        }
    }

    /// Checks native model eligibility through the same canonical Pi adapter predicate used by Tauri.
    func supportsCompaction(modelJSON: String) async throws -> Bool {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
            queue.async { [weak self] in
                guard let self else {
                    continuation.resume(throwing: PiRuntimeFailure(message: "The Pi runtime is unavailable"))
                    return
                }
                scriptError = nil
                let result = runtimeObject()?.invokeMethod("supportsCompaction", withArguments: [modelJSON])
                if let scriptError {
                    continuation.resume(throwing: PiRuntimeFailure(message: scriptError))
                    return
                }
                guard let result, !result.isUndefined, !result.isNull else {
                    continuation.resume(throwing: PiRuntimeFailure(message: "The Pi runtime returned no compaction capability"))
                    return
                }
                continuation.resume(returning: result.toBool())
            }
        }
    }

    /// Creates a harness through the shared canonical app factory and restores its durable workspace.
    @discardableResult
    func createHarness(
        optionsJSON: String,
        completion: @escaping @Sendable (Result<String, PiRuntimeFailure>) -> Void
    ) -> String {
        let requestID = UUID().uuidString.lowercased()
        queue.async { [weak self] in
            guard let self else { return }
            self.harnessCompletions[requestID] = completion
            if let registration = Self.transportRegistration(from: optionsJSON) {
                guard self.bridge?.registerModelTransport(registration) == true else {
                    self.completeHarness(requestID, harnessID: "", error: "The native model transport registration is invalid")
                    return
                }
                self.pendingTransportRegistrations[requestID] = registration.id
            }
            let script = """
            __thunderboltPiRuntime.createHarness(\(Self.javascriptLiteral(optionsJSON)))
              .then(function(id) { __thunderboltNative.completeHarness(\(Self.javascriptLiteral(requestID)), id, ''); })
              .catch(function(error) { __thunderboltNative.completeHarness(\(Self.javascriptLiteral(requestID)), '', String(error && error.message || error)); });
            """
            self.evaluate(script, failure: { error in
                self.completeHarness(requestID, harnessID: "", error: error.message)
            })
        }
        return requestID
    }

    /// Converts persisted UI-message parts and transient local attachment bytes using the web app's canonical preparation pipeline.
    @discardableResult
    func prepareConversation(
        messagesJSON: String,
        attachmentsJSON: String,
        workspaceEnabled: Bool,
        skillInstructionsJSON: String,
        completion: @escaping @Sendable (Result<String, PiRuntimeFailure>) -> Void
    ) -> String {
        let requestID = UUID().uuidString.lowercased()
        queue.async { [weak self] in
            guard let self else { return }
            self.preparationCompletions[requestID] = completion
            let script = """
            __thunderboltPiRuntime.prepareConversation(
              \(Self.javascriptLiteral(messagesJSON)), \(Self.javascriptLiteral(attachmentsJSON)), \(workspaceEnabled),
              \(Self.javascriptLiteral(skillInstructionsJSON)))
              .then(function(json) { __thunderboltNative.completePreparation(\(Self.javascriptLiteral(requestID)), json, ''); })
              .catch(function(error) { __thunderboltNative.completePreparation(\(Self.javascriptLiteral(requestID)), '', String(error && error.message || error)); });
            """
            self.evaluate(script, failure: { error in
                self.completePreparation(requestID, json: "", error: error.message)
            })
        }
        return requestID
    }

    func prepareConversation(
        messagesJSON: String,
        attachmentsJSON: String,
        workspaceEnabled: Bool,
        skillInstructionsJSON: String
    ) async throws -> String {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            prepareConversation(
                messagesJSON: messagesJSON,
                attachmentsJSON: attachmentsJSON,
                workspaceEnabled: workspaceEnabled,
                skillInstructionsJSON: skillInstructionsJSON
            ) { result in
                continuation.resume(with: result)
            }
        }
    }

    /// Produces a durable checkpoint using the shared built-in conversation and Pi compaction pipeline.
    func compactConversation(
        optionsJSON: String,
        messagesJSON: String,
        attachmentsJSON: String,
        workspaceEnabled: Bool,
        instructions: String?
    ) async throws -> String {
        let requestID = UUID().uuidString.lowercased()
        let instructionsJSON = instructions.map(Self.javascriptLiteral) ?? "null"
        _ = queue.sync { activeCompactionRequests.insert(requestID) }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
                queue.async { [weak self] in
                    guard let self else {
                        continuation.resume(throwing: PiRuntimeFailure(message: "The Pi runtime is unavailable"))
                        return
                    }
                    if cancelledCompactions.remove(requestID) != nil {
                        activeCompactionRequests.remove(requestID)
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    if let registration = Self.transportRegistration(from: optionsJSON) {
                        guard bridge?.registerModelTransport(registration) == true else {
                            activeCompactionRequests.remove(requestID)
                            continuation.resume(throwing: PiRuntimeFailure(message: "The native model transport registration is invalid"))
                            return
                        }
                        compactionTransportRegistrations[requestID] = registration.id
                    } else if Self.containsTransportRegistration(optionsJSON) {
                        activeCompactionRequests.remove(requestID)
                        continuation.resume(throwing: PiRuntimeFailure(message: "The native model transport registration is invalid"))
                        return
                    }
                    preparationCompletions[requestID] = { [weak self] result in
                        guard let self else {
                            continuation.resume(throwing: PiRuntimeFailure(message: "The Pi runtime is unavailable"))
                            return
                        }
                        if cancelledCompactions.remove(requestID) != nil {
                            continuation.resume(throwing: CancellationError())
                        } else {
                            continuation.resume(with: result)
                        }
                    }
                    let script = """
                    __thunderboltPiRuntime.compactConversation(
                      \(Self.javascriptLiteral(requestID)), \(Self.javascriptLiteral(optionsJSON)),
                      \(Self.javascriptLiteral(messagesJSON)), \(Self.javascriptLiteral(attachmentsJSON)),
                      \(workspaceEnabled), \(instructionsJSON))
                      .then(function(json) { __thunderboltNative.completePreparation(\(Self.javascriptLiteral(requestID)), json, ''); })
                      .catch(function(error) { __thunderboltNative.completePreparation(\(Self.javascriptLiteral(requestID)), '', String(error && error.message || error)); });
                    """
                    self.evaluate(script, failure: { error in
                        self.completePreparation(requestID, json: "", error: error.message)
                    })
                }
            }
        } onCancel: { [weak self] in
            guard let self else { return }
            self.queue.async { [weak self] in
                guard let self, activeCompactionRequests.contains(requestID) else { return }
                cancelledCompactions.insert(requestID)
                runtimeObject()?.invokeMethod("cancelCompaction", withArguments: [requestID])
            }
        }
    }

    private static func containsTransportRegistration(_ optionsJSON: String) -> Bool {
        guard let data = optionsJSON.data(using: .utf8),
              let options = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return options["transportRegistration"] != nil && !(options["transportRegistration"] is NSNull)
    }

    /// Streams AI SDK UI-message SSE chunks from the real in-process Pi harness.
    @discardableResult
    func run(
        harnessID: String,
        prompt: String,
        imagesJSON: String = "[]",
        onChunk: @escaping @Sendable (String) -> Void,
        onComplete: @escaping @Sendable (PiRuntimeFailure?) -> Void
    ) -> String {
        let requestID = UUID().uuidString.lowercased()
        queue.async { [weak self] in
            guard let self else { return }
            self.streamCallbacks[requestID] = StreamCallbacks(onChunk: onChunk, onComplete: onComplete)
            let script = """
            __thunderboltPiRuntime.run(\(Self.javascriptLiteral(harnessID)), \(Self.javascriptLiteral(prompt)), \(Self.javascriptLiteral(imagesJSON)),
              function(chunk) { __thunderboltNative.appendStreamChunk(\(Self.javascriptLiteral(requestID)), chunk); },
              function(error) { __thunderboltNative.completeStream(\(Self.javascriptLiteral(requestID)), String(error || '')); });
            """
            self.evaluate(script, failure: { error in
                self.completeStream(requestID, error: error.message)
            })
        }
        return requestID
    }

    func stop(harnessID: String) {
        queue.async { [weak self] in
            self?.runtimeObject()?.invokeMethod("stop", withArguments: [harnessID])
        }
    }

    func dispose(harnessID: String) {
        queue.async { [weak self] in
            guard let self else { return }
            self.runtimeObject()?.invokeMethod("dispose", withArguments: [harnessID])
            if let registrationID = self.harnessTransportRegistrations.removeValue(forKey: harnessID) {
                self.bridge?.revokeModelTransport(registrationID)
            }
        }
    }

    /// Stops every active harness and waits for tool/persistence work to drain.
    func shutdown() async throws {
        let requestID = UUID().uuidString.lowercased()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { [weak self] in
                guard let self else {
                    continuation.resume(throwing: PiRuntimeFailure(message: "The Pi runtime is unavailable"))
                    return
                }
                shutdownCompletions[requestID] = { result in continuation.resume(with: result) }
                let script = """
                __thunderboltPiRuntime.shutdown()
                  .then(function() { __thunderboltNative.completeShutdown(\(Self.javascriptLiteral(requestID)), ''); })
                  .catch(function(error) { __thunderboltNative.completeShutdown(\(Self.javascriptLiteral(requestID)), String(error && error.message || error)); });
                """
                evaluate(script, failure: { error in
                    completeShutdown(requestID, error: error.message)
                })
            }
        }
    }

    /// Drains active work before removing this server/account's persisted virtual workspaces.
    func shutdownAndRemoveWorkspaces() async throws {
        try await shutdown()
        try NativeAgentWorkspaceStore.removeAccount(serverURL: serverURL, userID: userID)
    }

    func completeHarness(_ requestID: String, harnessID: String, error: String?) {
        guard let completion = harnessCompletions.removeValue(forKey: requestID) else { return }
        if let error, !error.isEmpty {
            if let registrationID = pendingTransportRegistrations.removeValue(forKey: requestID) {
                bridge?.revokeModelTransport(registrationID)
            }
            completion(.failure(PiRuntimeFailure(message: error)))
        } else {
            if let registrationID = pendingTransportRegistrations.removeValue(forKey: requestID) {
                harnessTransportRegistrations[harnessID] = registrationID
            }
            completion(.success(harnessID))
        }
    }

    func completePreparation(_ requestID: String, json: String, error: String?) {
        guard let completion = preparationCompletions.removeValue(forKey: requestID) else { return }
        activeCompactionRequests.remove(requestID)
        cancelledCompactions.remove(requestID)
        if let registrationID = compactionTransportRegistrations.removeValue(forKey: requestID) {
            bridge?.revokeModelTransport(registrationID)
        }
        if let error, !error.isEmpty { completion(.failure(PiRuntimeFailure(message: error))) }
        else { completion(.success(json)) }
    }

    func completeShutdown(_ requestID: String, error: String?) {
        guard let completion = shutdownCompletions.removeValue(forKey: requestID) else { return }
        bridge?.revokeAllModelTransports()
        harnessTransportRegistrations.removeAll()
        pendingTransportRegistrations.removeAll()
        if let error, !error.isEmpty { completion(.failure(PiRuntimeFailure(message: error))) }
        else { completion(.success(())) }
    }

    func appendChunk(_ requestID: String, chunk: String) {
        streamCallbacks[requestID]?.onChunk(chunk)
    }

    func completeStream(_ requestID: String, error: String?) {
        guard let callbacks = streamCallbacks.removeValue(forKey: requestID) else { return }
        callbacks.onComplete(error.flatMap { $0.isEmpty ? nil : PiRuntimeFailure(message: $0) })
    }

    private static func transportRegistration(from optionsJSON: String) -> NativeProviderTransportRegistration? {
        guard let data = optionsJSON.data(using: .utf8),
              let options = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let model = options["model"] as? [String: Any],
              let modelURLValue = model["baseURL"] as? String,
              let modelURL = URL(string: modelURLValue),
              let raw = options["transportRegistration"] as? [String: Any],
              let id = raw["id"] as? String,
              let rawKind = raw["kind"] as? String,
              let kind = NativeProviderTransportKind(rawValue: rawKind),
              let rawURL = raw["baseURL"] as? String,
              let baseURL = URL(string: rawURL),
              NativeAgentRuntimeBridge.sameEndpoint(baseURL, modelURL),
              let headers = options["requestHeaders"] as? [String: String],
              headers.first(where: { $0.key.caseInsensitiveCompare(NativePiModelDescriptor.transportRegistrationHeader) == .orderedSame })?.value == id else { return nil }
        return NativeProviderTransportRegistration(id: id, kind: kind, baseURL: baseURL)
    }

    private func evaluate(_ script: String, failure: (PiRuntimeFailure) -> Void) {
        scriptError = nil
        context.evaluateScript(script)
        if let scriptError { failure(PiRuntimeFailure(message: scriptError)) }
    }

    private func runtimeObject() -> JSValue? {
        context.objectForKeyedSubscript("__thunderboltPiRuntime")
    }

    private static func javascriptLiteral(_ value: String) -> String {
        let data = try! JSONEncoder().encode(value)
        return String(decoding: data, as: UTF8.self)
    }

}
