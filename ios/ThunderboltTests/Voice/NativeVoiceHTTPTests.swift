/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import XCTest
@testable import Thunderbolt

final class NativeVoiceHTTPTests: XCTestCase {
    override func tearDown() {
        VoiceURLProtocol.handler = nil
        super.tearDown()
    }

    func testTranscriptionUsesOpenAICompatibleMultipartRequest() async throws {
        let requests = CapturedVoiceRequests()
        VoiceURLProtocol.handler = { request in
            requests.append(request)
            return Self.response(request, status: 200, body: #"{"text":"recognized words"}"#)
        }
        let engine = try Self.engine()

        let text = try await engine.transcribe(wav: Data("RIFF-test-audio".utf8))

        XCTAssertEqual(text, "recognized words")
        let request = try XCTUnwrap(requests.all.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v1/audio/transcriptions")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer voice-secret")
        let contentType = try XCTUnwrap(request.value(forHTTPHeaderField: "Content-Type"))
        XCTAssertTrue(contentType.hasPrefix("multipart/form-data; boundary="))
        let body = String(decoding: try XCTUnwrap(Self.bodyData(request)), as: UTF8.self)
        XCTAssertTrue(body.contains("name=\"model\""))
        XCTAssertTrue(body.contains("whisper-test"))
        XCTAssertTrue(body.contains("filename=\"utterance.wav\""))
        XCTAssertTrue(body.contains("Content-Type: audio/wav"))
        XCTAssertTrue(body.contains("RIFF-test-audio"))
    }

    func testSpeechUsesSelectedModelVoiceAndWavResponse() async throws {
        let requests = CapturedVoiceRequests()
        VoiceURLProtocol.handler = { request in
            requests.append(request)
            return Self.response(request, status: 200, body: "audio", contentType: "audio/wav")
        }
        let engine = try Self.engine()

        let audio = try await engine.synthesize(text: "Hello there.")

        XCTAssertEqual(audio, Data("audio".utf8))
        let request = try XCTUnwrap(requests.all.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v1/audio/speech")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer voice-secret")
        let json = try XCTUnwrap(Self.bodyData(request)).jsonObject()
        XCTAssertEqual(json["model"] as? String, "tts-test")
        XCTAssertEqual(json["input"] as? String, "Hello there.")
        XCTAssertEqual(json["voice"] as? String, "alloy-test")
        XCTAssertEqual(json["response_format"] as? String, "wav")
        XCTAssertEqual(json["speed"] as? Double, 1)
    }

    func testProviderStatusIsReturnedAsNativeVoiceError() async throws {
        VoiceURLProtocol.handler = { request in
            Self.response(request, status: 503, body: "temporary outage")
        }
        let engine = try Self.engine()

        do {
            _ = try await engine.synthesize(text: "Hello")
            XCTFail("Expected a provider error")
        } catch let error as NativeVoiceEngineError {
            XCTAssertEqual(error, .provider(status: 503, detail: "temporary outage"))
        }
    }

    private static func engine() throws -> NativeOpenAICompatibleVoiceEngine {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VoiceURLProtocol.self]
        let preferences = NativeVoicePreferences(
            provider: .openAICompatible,
            baseURL: "http://localhost:18791/v1",
            apiKey: "voice-secret",
            sttModel: "whisper-test",
            ttsModel: "tts-test",
            ttsVoice: "alloy-test"
        )
        return try NativeOpenAICompatibleVoiceEngine(preferences: preferences, session: URLSession(configuration: configuration))
    }

    private static func response(
        _ request: URLRequest,
        status: Int,
        body: String,
        contentType: String = "application/json"
    ) -> (HTTPURLResponse, Data) {
        (
            HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": contentType])!,
            Data(body.utf8)
        )
    }

    private static func bodyData(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private final class VoiceURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler, let client else { return }
        let (response, data) = handler(request)
        client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client.urlProtocol(self, didLoad: data)
        client.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class CapturedVoiceRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var requests = [URLRequest]()

    var all: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    func append(_ request: URLRequest) {
        lock.lock()
        requests.append(request)
        lock.unlock()
    }
}

private extension Data {
    func jsonObject() throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: self) as? [String: Any])
    }
}
