/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Tinfoil

struct NativeConfidentialInferenceRequest: Sendable {
    let url: URL
    let method: String
    let headers: [String: String]
    let body: Data?
    var transportID: String? = nil
}

protocol NativeConfidentialInferenceTask: Sendable {
    func cancel()
}

protocol NativeConfidentialInferenceHandling: Sendable {
    func start(
        request: NativeConfidentialInferenceRequest,
        onHeaders: @escaping @Sendable (Int, [String: String]) -> Void,
        onChunk: @escaping @Sendable (Data) -> Void,
        onComplete: @escaping @Sendable (String?) -> Void
    ) -> any NativeConfidentialInferenceTask
}

protocol NativeTinfoilChatStreaming: Sendable {
    func stream(query: ChatQuery) -> AsyncThrowingStream<ChatStreamResult, Error>
}

protocol NativeTinfoilChatClientFactory: Sendable {
    func client() async throws -> any NativeTinfoilChatStreaming
}

private struct ManagedTinfoilStreamingClient: NativeTinfoilChatStreaming {
    let client: RouterOpenAIClient

    func stream(query: ChatQuery) -> AsyncThrowingStream<ChatStreamResult, Error> {
        client.chatsStream(query: query)
    }
}

/// Caches one SDK client per signed-in session; the SDK owns EHBP and attestation.
actor ManagedTinfoilChatClientFactory: NativeTinfoilChatClientFactory {
    private let configuration: ManagedTinfoilProviderConfiguration
    private var cachedClient: RouterOpenAIClient?

    init(configuration: ManagedTinfoilProviderConfiguration) {
        self.configuration = configuration
    }

    func client() async throws -> any NativeTinfoilChatStreaming {
        ManagedTinfoilStreamingClient(client: try await sdkClient())
    }

    func verify() async throws {
        let client = try await sdkClient()
        let verification = try await client.httpClient.ensureVerified()
        configuration.attestationCallbacks?.onVerificationResult(.success(verification))
    }

    private func sdkClient() async throws -> RouterOpenAIClient {
        if let cachedClient { return cachedClient }
        let client = try await ManagedTinfoilProvider.makeClient(configuration: configuration)
        cachedClient = client
        return client
    }

    func reset() {
        cachedClient = nil
    }
}

/// Adapts the SDK's verified OpenAI stream to the fetch/SSE contract used by Pi.
/// It handles only the managed Tinfoil endpoint; other requests remain on URLSession.
final class NativeManagedTinfoilInferenceAdapter: NativeConfidentialInferenceHandling, Sendable {
    private let endpoint: URL
    private let factory: any NativeTinfoilChatClientFactory

    init(backendURL: URL, factory: any NativeTinfoilChatClientFactory) throws {
        let relay = try ManagedTinfoilProvider.relayURL(for: backendURL)
        let endpoint = relay.appending(path: "chat/completions")
        self.endpoint = endpoint
        self.factory = factory
    }

    func start(
        request: NativeConfidentialInferenceRequest,
        onHeaders: @escaping @Sendable (Int, [String: String]) -> Void,
        onChunk: @escaping @Sendable (Data) -> Void,
        onComplete: @escaping @Sendable (String?) -> Void
    ) -> any NativeConfidentialInferenceTask {
        guard request.method.uppercased() == "POST", Self.matchesManagedEndpoint(request.url, endpoint: endpoint) else {
            Self.finishError(
                status: 404,
                message: "The managed confidential inference route was not found",
                onHeaders: onHeaders,
                onChunk: onChunk,
                onComplete: onComplete
            )
            return CompletedConfidentialInferenceTask()
        }
        guard let body = request.body,
              let query = try? JSONDecoder().decode(ChatQuery.self, from: body),
              query.stream else {
            Self.finishError(
                status: 400,
                message: "A valid streaming chat completion request is required",
                onHeaders: onHeaders,
                onChunk: onChunk,
                onComplete: onComplete
            )
            return CompletedConfidentialInferenceTask()
        }

        let task = Task {
            var responseStarted = false
            do {
                // Client creation completes router verification before a successful response is exposed.
                let client = try await factory.client()
                let stream = client.stream(query: query)
                var iterator = stream.makeAsyncIterator()
                guard let first = try await iterator.next() else {
                    onHeaders(200, Self.sseHeaders)
                    responseStarted = true
                    onChunk(Data("data: [DONE]\n\n".utf8))
                    onComplete(nil)
                    return
                }

                onHeaders(200, Self.sseHeaders)
                responseStarted = true
                onChunk(try Self.frame(first))
                while !Task.isCancelled, let result = try await iterator.next() {
                    onChunk(try Self.frame(result))
                }
                guard !Task.isCancelled else { return }
                onChunk(Data("data: [DONE]\n\n".utf8))
                onComplete(nil)
            } catch is CancellationError {
                // Complete the bridge request so its callback/task entries are released.
                onComplete("The request was aborted")
            } catch {
                if Task.isCancelled {
                    onComplete("The request was aborted")
                    return
                }
                if responseStarted {
                    onComplete("The confidential model stream failed")
                } else {
                    Self.finishError(
                        status: 502,
                        message: "The confidential model service is unavailable",
                        onHeaders: onHeaders,
                        onChunk: onChunk,
                        onComplete: onComplete
                    )
                }
            }
        }
        return ManagedConfidentialInferenceTask(task: task)
    }

    private static let sseHeaders = [
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive"
    ]

    private static func matchesManagedEndpoint(_ candidate: URL, endpoint: URL) -> Bool {
        guard let candidateComponents = URLComponents(url: candidate, resolvingAgainstBaseURL: false),
              let endpointComponents = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
        else { return false }
        return candidateComponents.scheme?.lowercased() == endpointComponents.scheme?.lowercased()
            && candidateComponents.host?.lowercased() == endpointComponents.host?.lowercased()
            && candidateComponents.port == endpointComponents.port
            && candidateComponents.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                == endpointComponents.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            && candidateComponents.user == nil
            && candidateComponents.password == nil
            && candidateComponents.fragment == nil
    }

    private static func frame(_ result: ChatStreamResult) throws -> Data {
        let json = try JSONEncoder().encode(result)
        var frame = Data("data: ".utf8)
        frame.append(json)
        frame.append(Data("\n\n".utf8))
        return frame
    }

    private static func finishError(
        status: Int,
        message: String,
        onHeaders: @escaping @Sendable (Int, [String: String]) -> Void,
        onChunk: @escaping @Sendable (Data) -> Void,
        onComplete: @escaping @Sendable (String?) -> Void
    ) {
        let headers = ["Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"]
        onHeaders(status, headers)
        let body = try? JSONSerialization.data(withJSONObject: ["error": ["message": message, "type": "invalid_request_error"]])
        if let body { onChunk(body) }
        onComplete(nil)
    }
}

struct ManagedConfidentialInferenceTask: NativeConfidentialInferenceTask {
    private let task: Task<Void, Never>

    init(task: Task<Void, Never>) {
        self.task = task
    }

    func cancel() {
        task.cancel()
    }
}

struct CompletedConfidentialInferenceTask: NativeConfidentialInferenceTask {
    func cancel() {}
}
