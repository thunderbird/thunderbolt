/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Tinfoil

protocol NativeTinfoilUserClientProviding: Sendable {
    func prepare() async throws -> URL
    func stream(query: ChatQuery, apiKey: String) async throws -> AsyncThrowingStream<ChatStreamResult, Error>
}

/// A user-authorized Tinfoil client that always seals request bodies with EHBP.
actor NativeTinfoilUserClientFactory: NativeTinfoilUserClientProviding {
    private let userCacheSecret: String
    private var httpClient: RouterHTTPClient?
    private let callbacks: NativeTinfoilAttestationCallbacks?

    init(userCacheSecret: String, attestationCallbacks: NativeTinfoilAttestationCallbacks? = nil) {
        self.userCacheSecret = userCacheSecret
        callbacks = attestationCallbacks
    }

    func prepare() async throws -> URL {
        let client = try await verifiedRouter()
        guard let baseURL = URL(string: "v1/", relativeTo: client.baseURL)?.absoluteURL else {
            throw NativeTinfoilUserProviderError.invalidRouterURL
        }
        return baseURL
    }

    func stream(query: ChatQuery, apiKey: String) async throws -> AsyncThrowingStream<ChatStreamResult, Error> {
        guard !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw NativeTinfoilUserProviderError.missingAPIKey
        }
        let client = try await verifiedRouter()
        let openAI = try RouterOpenAIClient(httpClient: client, apiKey: apiKey)
        return openAI.chatsStream(query: query)
    }

    func reset() {
        httpClient = nil
    }

    func verify() async throws {
        let client = try await verifiedRouter()
        let verification = try await client.ensureVerified()
        callbacks?.onVerificationResult(.success(verification))
    }

    private func verifiedRouter() async throws -> RouterHTTPClient {
        if let httpClient { return httpClient }
        guard !userCacheSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw NativeTinfoilUserProviderError.missingUserCacheSecret
        }
        let client = try await RouterHTTPClient(
            transportMode: .ehbp,
            userCacheSecret: userCacheSecret,
            onEnclaveVerified: callbacks?.onEnclaveVerified,
            onVerificationResult: callbacks?.onVerificationResult
        )
        callbacks?.onEndpoint(client.enclave)
        httpClient = client
        return client
    }
}

enum NativeTinfoilUserProviderError: Error, Equatable {
    case invalidRouterURL
    case missingAPIKey
    case missingUserCacheSecret
    case invalidRequest
}

/// Bridges direct user-configured Tinfoil requests through the SDK's attested router.
/// The bridge invokes this only for a registered `.tinfoilUser` model transport.
final class NativeTinfoilUserInferenceAdapter: NativeConfidentialInferenceHandling, Sendable {
    private let factory: any NativeTinfoilUserClientProviding
    private let accessToken: @Sendable (String) async throws -> String

    init(
        factory: any NativeTinfoilUserClientProviding,
        accessToken: @escaping @Sendable (String) async throws -> String
    ) {
        self.factory = factory
        self.accessToken = accessToken
    }

    func start(
        request: NativeConfidentialInferenceRequest,
        onHeaders: @escaping @Sendable (Int, [String: String]) -> Void,
        onChunk: @escaping @Sendable (Data) -> Void,
        onComplete: @escaping @Sendable (String?) -> Void
    ) -> any NativeConfidentialInferenceTask {
        guard request.method.uppercased() == "POST", Self.isChatCompletionURL(request.url),
              let transportID = request.transportID, !transportID.isEmpty,
              let body = request.body,
              let query = try? JSONDecoder().decode(ChatQuery.self, from: body),
              query.stream else {
            Self.finishError(
                status: 400,
                message: "A valid registered streaming Tinfoil request is required",
                onHeaders: onHeaders,
                onChunk: onChunk,
                onComplete: onComplete
            )
            return CompletedConfidentialInferenceTask()
        }

        let task = Task {
            var responseStarted = false
            do {
                let currentKey = try await accessToken(transportID)
                guard !currentKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw NativeTinfoilUserProviderError.missingAPIKey
                }
                let stream = try await factory.stream(query: query, apiKey: currentKey)
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
                onComplete("The request was aborted")
            } catch {
                if Task.isCancelled {
                    onComplete("The request was aborted")
                } else if responseStarted {
                    onComplete("The Tinfoil model stream failed")
                } else {
                    Self.finishError(
                        status: 502,
                        message: "The Tinfoil service could not complete attestation or inference",
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
        "Connection": "keep-alive",
    ]

    private static func isChatCompletionURL(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = components.host?.lowercased(), !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil else { return false }
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard components.scheme?.lowercased() == "https" ||
                (components.scheme?.lowercased() == "http" && loopback) else { return false }
        return components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).hasSuffix("v1/chat/completions")
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
        onHeaders(status, ["Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"])
        let body = try? JSONSerialization.data(withJSONObject: ["error": [
            "message": message, "type": "invalid_request_error",
        ]])
        if let body { onChunk(body) }
        onComplete(nil)
    }
}
