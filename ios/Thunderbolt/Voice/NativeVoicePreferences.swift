/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Foundation
import Observation

enum NativeVoiceProviderKind: String, Codable, CaseIterable, Hashable, Sendable {
    case thunderbolt
    case openAICompatible = "openai-compatible"
}

struct NativeVoicePreferences: Codable, Equatable, Sendable {
    var provider: NativeVoiceProviderKind
    var baseURL: String
    var apiKey: String
    var sttModel: String
    var ttsModel: String
    var ttsVoice: String

    static let `default` = NativeVoicePreferences(
        provider: .thunderbolt,
        baseURL: "",
        apiKey: "",
        sttModel: "whisper-large-v3-turbo",
        ttsModel: "qwen3-tts",
        ttsVoice: "aiden"
    )
}

enum NativeVoicePreferencesError: Error, Equatable {
    case invalidBaseURL
    case missingModel
}

/// Validates the same OpenAI-compatible endpoint shape as the web voice settings.
enum NativeVoiceConfiguration {
    static func validatedBaseURL(_ value: String) throws -> URL {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(), !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil else {
            throw NativeVoicePreferencesError.invalidBaseURL
        }
        let normalizedHost = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let isLoopback = ["localhost", "127.0.0.1", "::1"].contains(normalizedHost)
        guard scheme == "https" || (scheme == "http" && isLoopback) else {
            throw NativeVoicePreferencesError.invalidBaseURL
        }
        while components.path.hasSuffix("/") { components.path.removeLast() }
        guard let url = components.url else { throw NativeVoicePreferencesError.invalidBaseURL }
        return url
    }

    static func validate(_ preferences: NativeVoicePreferences) throws {
        guard !preferences.sttModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !preferences.ttsModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !preferences.ttsVoice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw NativeVoicePreferencesError.missingModel
        }
        if preferences.provider == .openAICompatible { _ = try validatedBaseURL(preferences.baseURL) }
    }
}

/// Account-scoped voice settings, stored in this device's Keychain because the
/// custom provider API key must not be written to UserDefaults or synced tables.
@MainActor
@Observable
final class NativeVoicePreferencesStore {
    private(set) var preferences: NativeVoicePreferences
    private(set) var error: String?

    @ObservationIgnored private let server: String
    @ObservationIgnored private let userID: String
    @ObservationIgnored private let vault: DeviceVault

    init(
        server: String,
        userID: String,
        vault: DeviceVault = DeviceVault(service: "net.thunderbird.thunderbolt.native.voice")
    ) throws {
        self.server = server
        self.userID = userID
        self.vault = vault
        preferences = try vault.load(NativeVoicePreferences.self, server: server, userID: userID) ?? .default
    }

    func save(_ preferences: NativeVoicePreferences) throws {
        do {
            try NativeVoiceConfiguration.validate(preferences)
            try vault.save(preferences, server: server, userID: userID)
            self.preferences = preferences
            error = nil
        } catch {
            self.error = error.localizedDescription
            throw error
        }
    }

    func remove() throws {
        try vault.remove(server: server, userID: userID)
        preferences = .default
        error = nil
    }
}

struct NativeVoiceModelOption: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let task: String?
    let voices: [String]
}

struct NativeVoiceDiscoveredModels: Equatable, Sendable {
    let stt: [String]
    let tts: [NativeVoiceModelOption]

    static func classify(_ models: [NativeVoiceModelOption]) -> NativeVoiceDiscoveredModels {
        var stt = [String]()
        var tts = [NativeVoiceModelOption]()
        for model in models {
            switch model.task {
            case "automatic-speech-recognition": stt.append(model.id)
            case "text-to-speech": tts.append(model)
            default:
                stt.append(model.id)
                tts.append(model)
            }
        }
        return NativeVoiceDiscoveredModels(stt: stt, tts: tts)
    }
}
