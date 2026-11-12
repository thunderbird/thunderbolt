/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

struct NativeModel: Sendable, Equatable, Identifiable {
    let id: String
    let provider: String
    let name: String
    let model: String
    let url: String?
    let providerConnectionID: String?
    let connectionAuthMethod: String?
    let isSystem: Int64
    let enabled: Int64
    let toolUsage: Int64
    let isConfidential: Int64
    let startWithReasoning: Int64
    let reasoningEffort: String?
    let supportsParallelToolCalls: Int64
    let contextWindow: Int64?
    let deletedAt: String?
    let defaultHash: String?
    let vendor: String?
    let description: String?
    let userID: String?
    let apiKey: String?
    let oauthProvider: String?
    let providerDefault: Int64?
    let connectionName: String?
    let connectionReady: Bool

    var requiresServer: Bool { provider == "thunderbolt" || (provider == "tinfoil" && isSystem == 1) }
    var requiresAPIKey: Bool { !["thunderbolt", "custom"].contains(provider) && !(provider == "tinfoil" && (isSystem == 1 || oauthProvider == "tinfoil")) }
    var isConfigured: Bool {
        guard enabled == 1, deletedAt == nil, connectionReady else { return false }
        if provider == "custom" && (url?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) { return false }
        return !requiresAPIKey || (apiKey?.isEmpty == false)
    }
}

struct NativeModelProfile: Sendable, Equatable, Identifiable {
    var id: String { modelID }
    let modelID: String
    let temperature: Double?
    let maxSteps: Int64?
    let maxAttempts: Int64?
    let nudgeThreshold: Int64?
    let useSystemMessageModeDeveloper: Int64
    let toolsOverride: String?
    let linkPreviewsOverride: String?
    let chatModeAddendum: String?
    let searchModeAddendum: String?
    let researchModeAddendum: String?
    let citationReinforcementEnabled: Int64
    let citationReinforcementPrompt: String?
    let nudgeFinalStep: String?
    let nudgePreventive: String?
    let nudgeRetry: String?
    let nudgeSearchFinalStep: String?
    let nudgeSearchPreventive: String?
    let nudgeSearchRetry: String?
    let providerOptionsJSON: String?
    let defaultHash: String?
    let deletedAt: String?
    let userID: String?
}

struct NativeModelCatalogSnapshot: Sendable, Equatable {
    let models: [NativeModel]
    let profiles: [String: NativeModelProfile]
    let settings: [String: String]
    let selectedModelID: String?
}

struct NativeModelRuntimeConfiguration: Sendable, Equatable {
    let model: NativeModel
    let profile: NativeModelProfile?
    let reasoningEffort: String?
    let isConfidentialThread: Bool
}

struct NativeModelProfileDraft: Sendable, Equatable {
    var temperature: Double?
    var maxSteps: Int64?
    var maxAttempts: Int64?
    var nudgeThreshold: Int64?
    var toolsOverride: String?
    var providerOptionsJSON: String?
}

struct NativeModelDefaultsPayload: Codable, Sendable, Equatable {
    let version: Double
    let models: [NativeModelDefault]

    enum CodingKeys: String, CodingKey {
        case version
        case models = "data"
    }
}

struct NativeModelConfigResponse: Decodable, Sendable {
    struct Defaults: Decodable, Sendable {
        let models: NativeModelDefaultsPayload?
    }

    let defaults: Defaults?
}

struct NativeModelDefault: Codable, Sendable, Equatable {
    let id: String
    let provider: String
    let name: String
    let model: String
    let url: String?
    let isSystem: Int64?
    let enabled: Int64
    let toolUsage: Int64
    let isConfidential: Int64
    let startWithReasoning: Int64
    let supportsParallelToolCalls: Int64
    let contextWindow: Int64?
    let deletedAt: String?
    let defaultHash: String?
    let vendor: String?
    let description: String?
    let userID: String?
}

enum NativeModelCatalogError: Error, Equatable {
    case modelNotFound(String)
    case modelUnavailable(String)
    case invalidReasoningEffort
    case invalidModel
    case invalidModelURL
    case urlRequired
    case apiKeyRequired
    case invalidProfile
    case systemModelIsReadOnly
    case invalidDefaultsPayload
    case missingOwner
}

extension NativeModelCatalogError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .modelNotFound(_): nativeString( "That model is no longer available.")
        case .modelUnavailable(_): nativeString( "That model is unavailable for this conversation.")
        case .invalidReasoningEffort: nativeString( "Choose a supported reasoning level.")
        case .invalidModel: nativeString( "Enter a valid model name, ID, and context window.")
        case .invalidModelURL: nativeString( "Use an HTTPS URL or a loopback HTTP URL.")
        case .urlRequired: nativeString( "A base URL is required for a custom provider.")
        case .apiKeyRequired: nativeString( "An API key is required for this provider.")
        case .invalidProfile: nativeString( "Check the profile values and provider options JSON.")
        case .systemModelIsReadOnly: nativeString( "Managed models cannot be edited or removed.")
        case .invalidDefaultsPayload: nativeString( "The server model defaults are invalid.")
        case .missingOwner: nativeString( "Sign in before changing synced model settings.")
        }
    }
}
