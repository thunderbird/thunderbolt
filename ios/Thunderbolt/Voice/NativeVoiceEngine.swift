/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Foundation
import Tinfoil

protocol NativeVoiceEngine: Sendable {
    var id: String { get }
    func prepare() async throws
    func transcribe(wav: Data) async throws -> String
    func synthesize(text: String) async throws -> Data
    func dispose() async
}

protocol NativeManagedVoiceClient: Sendable {
    func prepare() async throws
    func transcribe(wav: Data, model: String) async throws -> String
    func synthesize(text: String, model: String, voice: String) async throws -> Data
    func reset() async
}

private struct ManagedVoiceClient: NativeManagedVoiceClient {
    let client: RouterOpenAIClient

    func prepare() async throws { _ = try await client.httpClient.ensureVerified() }
    func reset() async {}

    func transcribe(wav: Data, model: String) async throws -> String {
        let result = try await client.audioTranscriptions(query: AudioTranscriptionQuery(
            file: wav, fileType: .wav, model: model
        ))
        return result.text
    }

    func synthesize(text: String, model: String, voice: String) async throws -> Data {
        let result = try await client.audioCreateSpeech(query: AudioSpeechQuery(
            model: model,
            input: text,
            voice: .custom(voice),
            instructions: NativeThunderboltVoiceEngine.instructions,
            responseFormat: .wav,
            speed: 1
        ))
        return result.audio
    }
}

/// Caches the attested managed client for the signed-in session, matching chat's
/// provider lifecycle while using Tinfoil's SDK audio endpoints for both directions.
actor ManagedTinfoilVoiceClientFactory: NativeManagedVoiceClient {
    private let configuration: ManagedTinfoilProviderConfiguration
    private var cached: ManagedVoiceClient?

    init(configuration: ManagedTinfoilProviderConfiguration) {
        self.configuration = configuration
    }

    func prepare() async throws {
        _ = try await client()
    }

    func transcribe(wav: Data, model: String) async throws -> String {
        try await client().transcribe(wav: wav, model: model)
    }

    func synthesize(text: String, model: String, voice: String) async throws -> Data {
        try await client().synthesize(text: text, model: model, voice: voice)
    }

    func reset() async { cached = nil }

    private func client() async throws -> ManagedVoiceClient {
        if let cached { return cached }
        let client = try await ManagedTinfoilProvider.makeClient(configuration: configuration)
        let result = ManagedVoiceClient(client: client)
        cached = result
        return result
    }
}

struct NativeThunderboltVoiceEngine: NativeVoiceEngine {
    let id = "thunderbolt"
    private let client: any NativeManagedVoiceClient

    static let instructions = "Speak naturally and conversationally, like a warm, helpful friend. Relaxed and clear, with an even, moderate pace. Sound engaged but never theatrical — no shouting, exaggerated emphasis, or laughter."

    init(client: any NativeManagedVoiceClient) {
        self.client = client
    }

    func prepare() async throws { try await client.prepare() }

    func transcribe(wav: Data) async throws -> String {
        try Task.checkCancellation()
        return try await client.transcribe(wav: wav, model: "whisper-large-v3-turbo")
    }

    func synthesize(text: String) async throws -> Data {
        try Task.checkCancellation()
        return try await client.synthesize(text: text, model: "qwen3-tts", voice: "ryan")
    }

    func dispose() async { await client.reset() }
}

struct NativeOpenAICompatibleVoiceEngine: NativeVoiceEngine {
    let id = "openai-compatible"
    private let preferences: NativeVoicePreferences
    private let session: URLSession

    init(preferences: NativeVoicePreferences, session: URLSession = NativeVoiceURLSession.make()) throws {
        try NativeVoiceConfiguration.validate(preferences)
        self.preferences = preferences
        self.session = session
    }

    func prepare() async throws {}

    func transcribe(wav: Data) async throws -> String {
        let boundary = "thunderbolt-voice-\(UUID().uuidString)"
        var body = Data()
        Self.appendFormField("model", value: preferences.sttModel, boundary: boundary, to: &body)
        Self.appendFile("file", filename: "utterance.wav", mimeType: "audio/wav", bytes: wav, boundary: boundary, to: &body)
        body.append(Data("--\(boundary)--\r\n".utf8))
        var request = try makeRequest(path: "audio/transcriptions", method: "POST")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let data = try await perform(request)
        let response = try JSONDecoder().decode(TranscriptionResponse.self, from: data)
        return response.text
    }

    func synthesize(text: String) async throws -> Data {
        var request = try makeRequest(path: "audio/speech", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(SpeechRequest(
            model: preferences.ttsModel,
            input: text,
            voice: preferences.ttsVoice,
            responseFormat: "wav",
            speed: 1
        ))
        return try await perform(request)
    }

    func dispose() async {}

    private func makeRequest(path: String, method: String) throws -> URLRequest {
        guard let base = try? NativeVoiceConfiguration.validatedBaseURL(preferences.baseURL) else {
            throw NativeVoicePreferencesError.invalidBaseURL
        }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        let prefix = components?.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
        components?.path = "/" + [prefix, path].filter { !$0.isEmpty }.joined(separator: "/")
        guard let url = components?.url else { throw NativeVoicePreferencesError.invalidBaseURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.httpShouldHandleCookies = false
        if !preferences.apiKey.isEmpty { request.setValue("Bearer \(preferences.apiKey)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        try Task.checkCancellation()
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse else { throw NativeVoiceEngineError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let detail = String(decoding: data.prefix(2048), as: UTF8.self)
            throw NativeVoiceEngineError.provider(status: response.statusCode, detail: detail)
        }
        return data
    }

    private static func appendFormField(_ name: String, value: String, boundary: String, to data: inout Data) {
        data.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }

    private static func appendFile(_ name: String, filename: String, mimeType: String, bytes: Data, boundary: String, to data: inout Data) {
        data.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\nContent-Type: \(mimeType)\r\n\r\n".utf8))
        data.append(bytes)
        data.append(Data("\r\n".utf8))
    }

    private struct TranscriptionResponse: Decodable { let text: String }
    private struct SpeechRequest: Encodable {
        let model: String
        let input: String
        let voice: String
        let responseFormat: String
        let speed: Double

        enum CodingKeys: String, CodingKey {
            case model, input, voice, speed
            case responseFormat = "response_format"
        }
    }
}

enum NativeVoiceEngineError: Error, Equatable {
    case invalidResponse
    case provider(status: Int, detail: String)
    case invalidAudio
    case microphonePermissionDenied
    case microphoneUnavailable
    case interrupted
}

enum NativeVoiceURLSession {
    static func make() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        return URLSession(configuration: configuration, delegate: NativeVoiceNoRedirectDelegate(), delegateQueue: nil)
    }
}

private final class NativeVoiceNoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) { completionHandler(nil) }
}
