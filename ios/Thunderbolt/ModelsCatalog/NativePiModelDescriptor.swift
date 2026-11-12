/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

enum NativeProviderTransportKind: String, Sendable, Equatable {
    case direct
    case customNoAuth
    case tinfoilUser
}

/// Native-only authorization for one model transport, registered for a Pi run.
struct NativeProviderTransportRegistration: Sendable, Equatable {
    let id: String
    let kind: NativeProviderTransportKind
    let baseURL: URL
}

struct NativePiModelDescriptor: Sendable, Equatable {
    let descriptor: ChatJSONValue
    let requestHeaders: [String: String]
    let thinkingLevel: String
    let transportRegistration: NativeProviderTransportRegistration?

    static let transportRegistrationHeader = "X-Thunderbolt-Transport-ID"

    static func build(
        runtime: NativeModelRuntimeConfiguration,
        backendURL: URL,
        token: String?,
        deviceID: String?,
        tinfoilUserBaseURL: URL? = nil,
        reasoning resolution: NativeReasoningResolution? = nil
    ) throws -> NativePiModelDescriptor {
        let model = runtime.model
        guard model.isConfidential == (runtime.isConfidentialThread ? 1 : 0) else {
            throw NativePiModelDescriptorError.confidentialityMismatch
        }
        let thinkingLevel = resolution?.thinkingLevel ?? "off"
        let reasoning = resolution?.capabilities.efforts.contains(where: { $0 != "none" }) == true

        switch model.provider {
        case "tinfoil":
            guard model.isSystem == 1, model.isConfidential == 1 else {
                guard runtime.isConfidentialThread else { throw NativePiModelDescriptorError.confidentialityMismatch }
                guard let apiKey = nonempty(model.apiKey) else { throw NativePiModelDescriptorError.missingAPIKey }
                guard let tinfoilUserBaseURL else { throw NativePiModelDescriptorError.tinfoilUserTransportUnavailable }
                let baseURL = try normalizedOpenAIBaseURL(tinfoilUserBaseURL.absoluteString)
                let registration = makeRegistration(kind: .tinfoilUser, baseURL: baseURL)
                return NativePiModelDescriptor(
                    descriptor: .object([
                        "kind": .string("openai-compat"), "providerId": .string("tinfoil"),
                        "modelId": .string(model.model), "baseURL": .string(baseURL.absoluteString),
                        "apiKey": .string(apiKey), "reasoning": .bool(reasoning),
                        "supportsImages": .bool(supportsImages(model)),
                    ].merging(optionalContextWindow(model.contextWindow)) { current, _ in current }),
                    requestHeaders: [transportRegistrationHeader: registration.id],
                    thinkingLevel: thinkingLevel,
                    transportRegistration: registration
                )
            }
            guard runtime.isConfidentialThread else {
                throw NativePiModelDescriptorError.confidentialityMismatch
            }
            let relayURL = try managedRelayURL(backendURL)
            let managedToken = try requiredToken(token)
            let descriptor: [String: ChatJSONValue] = [
                "kind": .string("confidential"),
                "providerId": .string("tinfoil"),
                "modelId": .string(model.model),
                "vendor": model.vendor.map(ChatJSONValue.string) ?? .null,
                "baseURL": .string(relayURL.absoluteString),
                "apiKey": .string("thunderbolt-managed"),
                "reasoning": .bool(reasoning),
                "supportsImages": .bool(supportsImages(model)),
            ].merging(optionalContextWindow(model.contextWindow)) { current, _ in current }
            return NativePiModelDescriptor(
                descriptor: .object(descriptor),
                requestHeaders: managedHeaders(token: managedToken, deviceID: deviceID, inferenceModel: model.model),
                thinkingLevel: thinkingLevel,
                transportRegistration: nil
            )

        case "thunderbolt":
            let managedToken = try requiredToken(token)
            let headers = managedHeaders(token: managedToken, deviceID: deviceID)
            if model.vendor == "anthropic" {
                let baseURL = try managedBackendURL(backendURL).appending(path: "chat")
                var descriptor: [String: ChatJSONValue] = [
                    "kind": .string("anthropic"),
                    "modelId": .string(model.model),
                    "catalogModelId": .string(managedAnthropicCatalogID(model.model)),
                    "baseURL": .string(baseURL.absoluteString),
                    "apiKey": .string(managedToken),
                ]
                descriptor.merge(optionalContextWindow(model.contextWindow)) { current, _ in current }
                return NativePiModelDescriptor(descriptor: .object(descriptor), requestHeaders: headers, thinkingLevel: thinkingLevel, transportRegistration: nil)
            }

            var descriptor: [String: ChatJSONValue] = [
                "kind": .string("openai-compat"),
                "providerId": .string("thunderbolt"),
                "modelId": .string(model.model),
                "baseURL": .string(try managedBackendURL(backendURL).absoluteString),
                "apiKey": .string(managedToken),
                "reasoning": .bool(reasoning),
                "supportsImages": .bool(supportsImages(model)),
            ]
            descriptor.merge(optionalContextWindow(model.contextWindow)) { current, _ in current }
            return NativePiModelDescriptor(descriptor: .object(descriptor), requestHeaders: headers, thinkingLevel: thinkingLevel, transportRegistration: nil)

        case "anthropic":
            guard let apiKey = nonempty(model.apiKey) else { throw NativePiModelDescriptorError.missingAPIKey }
            guard let baseURL = URL(string: "https://api.anthropic.com") else {
                throw NativePiModelDescriptorError.invalidProviderURL
            }
            let registration = makeRegistration(kind: .direct, baseURL: baseURL)
            return NativePiModelDescriptor(
                descriptor: .object([
                    "kind": .string("anthropic"),
                    "modelId": .string(model.model),
                    "baseURL": .string(baseURL.absoluteString),
                    "apiKey": .string(apiKey),
                ].merging(optionalContextWindow(model.contextWindow)) { current, _ in current }),
                requestHeaders: [transportRegistrationHeader: registration.id],
                thinkingLevel: thinkingLevel,
                transportRegistration: registration
            )

        case "openai", "openrouter", "custom", "otari":
            let configuredAPIKey = nonempty(model.apiKey)
            guard configuredAPIKey != nil || model.provider == "custom" else { throw NativePiModelDescriptorError.missingAPIKey }
            let baseURL: URL
            let api: String?
            switch model.provider {
            case "openai":
                baseURL = URL(string: "https://api.openai.com/v1")!
                api = model.provider == "openai" && model.connectionAuthMethod == "oauth" ? "openai-responses" : nil
            case "openrouter":
                baseURL = URL(string: "https://openrouter.ai/api/v1")!
                api = nil
            case "custom", "otari":
                guard let url = model.url else { throw NativePiModelDescriptorError.invalidProviderURL }
                baseURL = try normalizedOpenAIBaseURL(url)
                api = nil
            default:
                throw NativePiModelDescriptorError.unsupportedProvider(model.provider)
            }
            let registrationKind: NativeProviderTransportKind = model.provider == "custom" && configuredAPIKey == nil
                ? .customNoAuth : .direct
            let registration = makeRegistration(kind: registrationKind, baseURL: baseURL)
            var descriptor: [String: ChatJSONValue] = [
                "kind": .string("openai-compat"),
                "providerId": .string(model.provider),
                "modelId": .string(model.model),
                "baseURL": .string(baseURL.absoluteString),
                // Pi's OpenAI client requires a nonempty key at construction.
                // The registered customNoAuth transport removes it at the native boundary.
                "apiKey": .string(configuredAPIKey ?? "thunderbolt-no-auth"),
                "reasoning": .bool(reasoning),
                "supportsImages": .bool(supportsImages(model)),
            ]
            if let api { descriptor["api"] = .string(api) }
            descriptor.merge(optionalContextWindow(model.contextWindow)) { current, _ in current }
            return NativePiModelDescriptor(
                descriptor: .object(descriptor),
                requestHeaders: [transportRegistrationHeader: registration.id],
                thinkingLevel: thinkingLevel,
                transportRegistration: registration
            )

        default:
            throw NativePiModelDescriptorError.unsupportedProvider(model.provider)
        }
    }

    private static func optionalContextWindow(_ value: Int64?) -> [String: ChatJSONValue] {
        guard let value, value > 0 else { return [:] }
        return ["contextWindow": .number(Double(value))]
    }

    private static func managedHeaders(token: String, deviceID: String?, inferenceModel: String? = nil) -> [String: String] {
        var headers = [
            "Authorization": "Bearer \(token)",
            "X-Client-Platform": "ios",
        ]
        if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String, !version.isEmpty {
            headers["X-App-Version"] = version
        }
        if let deviceID = nonempty(deviceID) { headers["X-Device-ID"] = deviceID }
        if let inferenceModel { headers["X-Inference-Model"] = inferenceModel }
        return headers
    }

    private static func makeRegistration(kind: NativeProviderTransportKind, baseURL: URL) -> NativeProviderTransportRegistration {
        NativeProviderTransportRegistration(id: UUID().uuidString.lowercased(), kind: kind, baseURL: baseURL)
    }

    private static func requiredToken(_ token: String?) throws -> String {
        guard let token = nonempty(token) else { throw NativePiModelDescriptorError.missingSessionToken }
        return token
    }

    private static func managedBackendURL(_ backendURL: URL) throws -> URL {
        try validateSecureURL(backendURL)
    }

    private static func managedRelayURL(_ backendURL: URL) throws -> URL {
        try ManagedTinfoilProvider.relayURL(for: backendURL)
    }

    private static func validateSecureURL(_ url: URL) throws -> URL {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil
        else { throw NativePiModelDescriptorError.invalidProviderURL }
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard parts.scheme?.lowercased() == "https" || (parts.scheme?.lowercased() == "http" && loopback) else {
            throw NativePiModelDescriptorError.invalidProviderURL
        }
        return url
    }

    private static func normalizedOpenAIBaseURL(_ rawValue: String) throws -> URL {
        let raw = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var parts = URLComponents(string: raw),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil
        else { throw NativePiModelDescriptorError.invalidProviderURL }
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard parts.scheme?.lowercased() == "https" || (parts.scheme?.lowercased() == "http" && loopback) else {
            throw NativePiModelDescriptorError.invalidProviderURL
        }
        while parts.path.hasSuffix("/") { parts.path.removeLast() }
        if !parts.path.hasSuffix("/v1") { parts.path += "/v1" }
        guard let url = parts.url else { throw NativePiModelDescriptorError.invalidProviderURL }
        return url
    }

    private static func supportsImages(_ model: NativeModel) -> Bool {
        if let shipped = NativeModelDefaults.models.first(where: {
            $0.provider == model.provider && $0.model == model.model
        }) {
            return shipped.id != "019e7580-2b0e-719c-a43f-d2b56e7f31b4"
        }
        if model.provider == "anthropic" { return true }
        if model.provider == "thunderbolt", ["anthropic", "openai", "google"].contains(model.vendor ?? "") { return true }
        return true
    }

    private static func managedAnthropicCatalogID(_ modelID: String) -> String {
        modelID == "opus-5-5" ? "claude-opus-5" : "claude-\(modelID)"
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let value else { return nil }
        return value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : value
    }
}

enum NativePiModelDescriptorError: Error, Equatable {
    case unsupportedProvider(String)
    case missingAPIKey
    case missingSessionToken
    case invalidProviderURL
    case requiresLegacyTransport
    case directTinfoilUnsupported
    case tinfoilUserTransportUnavailable
    case confidentialityMismatch
}
