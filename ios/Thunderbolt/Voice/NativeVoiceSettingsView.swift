/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct NativeVoiceSettingsView: View {
    let store: NativeVoicePreferencesStore
    let customProviderEnabled: Bool

    @State private var draft: NativeVoicePreferences
    @State private var discovered = NativeVoiceDiscoveredModels(stt: [], tts: [])
    @State private var status: String?
    @State private var isWorking = false

    init(store: NativeVoicePreferencesStore, customProviderEnabled: Bool) {
        self.store = store
        self.customProviderEnabled = customProviderEnabled
        _draft = State(initialValue: store.preferences)
    }

    var body: some View {
        TBSettingsPage(nativeString("Voice")) {
            TBSettingsSection(nativeString("Voice engine")) {
                TBSettingsFieldLabel(title: nativeString("Provider"))
                Picker(nativeString( "Provider"), selection: $draft.provider) {
                    Text(nativeString( "Thunderbolt (hosted, private)"))
                        .tag(NativeVoiceProviderKind.thunderbolt)
                    if customProviderEnabled {
                        Text(nativeString( "Custom OpenAI-compatible"))
                            .tag(NativeVoiceProviderKind.openAICompatible)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("voiceProvider")

                if draft.provider == .thunderbolt {
                    Text(nativeString( "Speech runs through Thunderbolt’s confidential enclave."))
                        .font(.system(size: 14))
                        .foregroundStyle(TBPalette.muted)
                } else {
                    Text(nativeString( "Use an OpenAI-compatible endpoint with audio transcription and speech routes."))
                        .font(.system(size: 14))
                        .foregroundStyle(TBPalette.muted)
                    TextField("Base URL", text: $draft.baseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .tbSettingsInputStyle()
                        .accessibilityIdentifier("voiceBaseURL")
                    SecureField(nativeString( "API key (optional)"), text: $draft.apiKey)
                        .textInputAutocapitalization(.never)
                        .tbSettingsInputStyle()
                        .accessibilityIdentifier("voiceAPIKey")
                    modelField(nativeString( "Speech to text model"), value: $draft.sttModel, options: discovered.stt)
                    modelField(nativeString( "Text to speech model"), value: $draft.ttsModel, options: discovered.tts.map(\.id))
                    modelField(
                        nativeString( "Voice"),
                        value: $draft.ttsVoice,
                        options: discovered.tts.first(where: { $0.id == draft.ttsModel })?.voices ?? []
                    )

                    TBSettingsDivider()
                    VStack(alignment: .leading, spacing: 10) {
                        Button(nativeString( "Load models"), action: { Task { await loadModels() } })
                            .disabled(isWorking)
                            .frame(maxWidth: .infinity, minHeight: 44)
                        Button(nativeString( "Test connection"), action: { Task { await testConnection() } })
                            .disabled(isWorking)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
            }

            TBSettingsSection(nativeString("Settings")) {
                Button(nativeString( "Save voice settings"), action: save)
                    .buttonStyle(TBSettingsPrimaryButtonStyle())
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("saveVoiceSettings")
                if let status { Text(status).font(.system(size: 14)).foregroundStyle(TBPalette.muted) }
                if let error = store.error { Text(error).font(.system(size: 14)).foregroundStyle(.red) }
            }
        }
    }

    @ViewBuilder
    private func modelField(_ title: String, value: Binding<String>, options: [String]) -> some View {
        if options.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                TBSettingsFieldLabel(title: title)
                TextField(title, text: value)
                    .textInputAutocapitalization(.never)
                    .tbSettingsInputStyle()
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                TBSettingsFieldLabel(title: title)
                Picker(title, selection: value) {
                    ForEach(options, id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.menu)
            }
        }
    }

    private func save() {
        do {
            if !customProviderEnabled { draft.provider = .thunderbolt }
            try store.save(draft)
            status = nativeString( "Voice settings saved.")
        } catch {
            status = error.localizedDescription
        }
    }

    private func loadModels() async {
        guard let url = try? NativeVoiceConfiguration.validatedBaseURL(draft.baseURL) else {
            status = NativeVoicePreferencesError.invalidBaseURL.localizedDescription
            return
        }
        isWorking = true
        defer { isWorking = false }
        do {
            discovered = try await NativeVoiceSettingsClient.discoverModels(baseURL: url, apiKey: draft.apiKey)
            status = discovered.stt.isEmpty && discovered.tts.isEmpty
                ? nativeString( "No models returned. Enter model and voice IDs manually.")
                : nativeString( "Models loaded.")
        } catch {
            status = error.localizedDescription
        }
    }

    private func testConnection() async {
        isWorking = true
        defer { isWorking = false }
        do {
            let engine = try NativeOpenAICompatibleVoiceEngine(preferences: draft)
            _ = try await engine.synthesize(text: "Connection test.")
            status = nativeString( "Connected — synthesis succeeded.")
        } catch {
            status = error.localizedDescription
        }
    }
}

enum NativeVoiceSettingsClient {
    private struct ModelResponse: Decodable {
        struct Item: Decodable {
            struct Voice: Decodable { let id: String }
            let id: String
            let task: String?
            let voices: [Voice]?
        }
        let data: [Item]?
    }

    static func discoverModels(baseURL: URL, apiKey: String) async throws -> NativeVoiceDiscoveredModels {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        let prefix = baseURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components?.path = prefix.isEmpty ? "/models" : "/\(prefix)/models"
        guard let url = components?.url else { throw NativeVoicePreferencesError.invalidBaseURL }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.httpShouldHandleCookies = false
        if !apiKey.isEmpty { request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await NativeVoiceURLSession.make().data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw NativeVoiceEngineError.provider(
                status: (response as? HTTPURLResponse)?.statusCode ?? 0,
                detail: String(decoding: data.prefix(2048), as: UTF8.self)
            )
        }
        let raw = try JSONDecoder().decode(ModelResponse.self, from: data).data ?? []
        return NativeVoiceDiscoveredModels.classify(raw.map {
            NativeVoiceModelOption(id: $0.id, task: $0.task, voices: $0.voices?.map(\.id) ?? [])
        })
    }
}
