/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class NativePiModelDescriptorTests: XCTestCase {
    func testManagedTinfoilBuildsConfidentialDescriptorAndUsesOnlyServerHeaders() throws {
        let model = Self.model(provider: "tinfoil", model: "glm-5-3", vendor: "zhipu", isSystem: 1,
                               isConfidential: 1, contextWindow: 131_072)
        let result = try Self.build(model: model, profile: Self.profile(#"{"reasoningEffort":"high"}"#), encrypted: true,
            reasoning: NativeReasoningResolution(capabilities: NativeReasoningCapabilities(efforts: ["high"]),
                preference: nil, requestEffort: nil, profileEffort: "high", profileConfigured: true, preferredEffort: "high", thinkingLevel: "high"))

        XCTAssertEqual(result.descriptor["kind"]?.stringValue, "confidential")
        XCTAssertEqual(result.descriptor["providerId"]?.stringValue, "tinfoil")
        XCTAssertEqual(result.descriptor["baseURL"]?.stringValue, "https://api.example.test/v1/tinfoil")
        XCTAssertEqual(result.descriptor["apiKey"]?.stringValue, "thunderbolt-managed")
        XCTAssertEqual(result.descriptor["reasoning"]?.boolValue, true)
        XCTAssertEqual(result.descriptor["supportsImages"]?.boolValue, false)
        XCTAssertEqual(result.descriptor["contextWindow"], .number(131_072))
        XCTAssertEqual(result.requestHeaders["Authorization"], "Bearer session-token")
        XCTAssertEqual(result.requestHeaders["X-Device-ID"], "device-1")
        XCTAssertEqual(result.requestHeaders["X-Inference-Model"], "glm-5-3")
        XCTAssertEqual(result.requestHeaders["X-Client-Platform"], "ios")
        XCTAssertEqual(result.thinkingLevel, "high")
    }

    func testUserTinfoilUsesRegisteredEHBPTransport() throws {
        let model = Self.model(provider: "tinfoil", model: "private-model", vendor: "deepseek", apiKey: "user-key",
                               isConfidential: 1)
        let result = try Self.build(model: model, encrypted: true,
                                    tinfoilUserBaseURL: URL(string: "https://router.tinfoil.test/v1")!)
        XCTAssertEqual(result.descriptor["kind"]?.stringValue, "openai-compat")
        XCTAssertEqual(result.descriptor["providerId"]?.stringValue, "tinfoil")
        XCTAssertEqual(result.descriptor["baseURL"]?.stringValue, "https://router.tinfoil.test/v1")
        XCTAssertEqual(result.descriptor["apiKey"]?.stringValue, "user-key")
        XCTAssertEqual(result.transportRegistration?.kind, .tinfoilUser)
        XCTAssertEqual(result.transportRegistration?.baseURL.absoluteString, "https://router.tinfoil.test/v1")
        XCTAssertEqual(result.requestHeaders[NativePiModelDescriptor.transportRegistrationHeader],
                       result.transportRegistration?.id)
        XCTAssertNil(result.requestHeaders["Authorization"])
    }

    func testUserTinfoilRequiresPrivateThreadAndPreparedAttestedRouter() {
        let model = Self.model(provider: "tinfoil", model: "private-model", vendor: "deepseek", apiKey: "user-key",
                               isConfidential: 1)
        XCTAssertThrowsError(try Self.build(model: model, encrypted: false,
            tinfoilUserBaseURL: URL(string: "https://router.tinfoil.test/v1")!)) { error in
            XCTAssertEqual(error as? NativePiModelDescriptorError, .confidentialityMismatch)
        }
        XCTAssertThrowsError(try Self.build(model: model, encrypted: true)) { error in
            XCTAssertEqual(error as? NativePiModelDescriptorError, .tinfoilUserTransportUnavailable)
        }
    }

    func testManagedAnthropicMapsOpusCatalogIDAndRoutesThroughThunderbolt() throws {
        let model = Self.model(provider: "thunderbolt", model: "opus-5-5", vendor: "anthropic", contextWindow: 1_000_000)
        let result = try Self.build(model: model)

        XCTAssertEqual(result.descriptor["kind"]?.stringValue, "anthropic")
        XCTAssertEqual(result.descriptor["modelId"]?.stringValue, "opus-5-5")
        XCTAssertEqual(result.descriptor["catalogModelId"]?.stringValue, "claude-opus-5")
        XCTAssertEqual(result.descriptor["baseURL"]?.stringValue, "https://api.example.test/v1/chat")
        XCTAssertEqual(result.descriptor["apiKey"]?.stringValue, "session-token")
        XCTAssertEqual(result.requestHeaders["Authorization"], "Bearer session-token")
        XCTAssertNil(result.requestHeaders["X-Inference-Model"])
    }

    func testOpenAIOAuthUsesResponsesAPIWithoutThunderboltHeaders() throws {
        let model = Self.model(provider: "openai", model: "gpt-5", apiKey: "provider-secret",
                               providerConnectionID: "openai-oauth", connectionAuthMethod: "oauth")
        let result = try Self.build(model: model)

        XCTAssertEqual(result.descriptor["api"]?.stringValue, "openai-responses")
        XCTAssertEqual(result.descriptor["baseURL"]?.stringValue, "https://api.openai.com/v1")
        XCTAssertEqual(result.descriptor["apiKey"]?.stringValue, "provider-secret")
        XCTAssertEqual(result.transportRegistration?.kind, .direct)
        XCTAssertEqual(result.requestHeaders[NativePiModelDescriptor.transportRegistrationHeader],
                       result.transportRegistration?.id)
    }

    func testDirectAnthropicUsesAnExplicitAllowedOrigin() throws {
        let model = Self.model(provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "provider-secret")
        let result = try Self.build(model: model)

        XCTAssertEqual(result.descriptor["baseURL"]?.stringValue, "https://api.anthropic.com")
        XCTAssertEqual(result.transportRegistration?.kind, .direct)
    }

    func testCustomNoKeyUsesExplicitNoAuthRegistrationAndRejectsRemoteHTTP() throws {
        let model = Self.model(provider: "custom", model: "local-model", url: "http://localhost:11434")
        let local = try Self.build(model: model)
        XCTAssertEqual(local.descriptor["apiKey"]?.stringValue, "thunderbolt-no-auth")
        XCTAssertEqual(local.transportRegistration?.kind, .customNoAuth)
        XCTAssertEqual(local.transportRegistration?.baseURL.absoluteString, "http://localhost:11434/v1")
        XCTAssertEqual(local.requestHeaders[NativePiModelDescriptor.transportRegistrationHeader],
                       local.transportRegistration?.id)
        let remote = Self.model(provider: "custom", model: "remote-model", url: "http://models.example.test/v1", apiKey: "key")
        XCTAssertThrowsError(try Self.build(model: remote)) { error in
            XCTAssertEqual(error as? NativePiModelDescriptorError, .invalidProviderURL)
        }
    }

    func testSavedReasoningOverridesProfileAndOffDisablesReasoningFlag() throws {
        let model = Self.model(provider: "openrouter", model: "provider/model", apiKey: "key", reasoningEffort: "max")
        let profile = Self.profile(#"{"reasoningEffort":"low"}"#)
        let selected = try Self.build(model: model, profile: profile,
            reasoning: NativeReasoningResolution(capabilities: NativeReasoningCapabilities(efforts: ["low", "max"]),
                preference: "max", requestEffort: "max", profileEffort: "low", profileConfigured: true, preferredEffort: "max", thinkingLevel: "max"))
        XCTAssertEqual(selected.thinkingLevel, "max")
        XCTAssertEqual(selected.descriptor["reasoning"]?.boolValue, true)

        let offModel = Self.model(provider: "openrouter", model: "provider/model", apiKey: "key")
        let off = try Self.build(model: offModel, profile: Self.profile(#"{"thinking":{"type":"disabled"}}"#))
        XCTAssertEqual(off.thinkingLevel, "off")
        XCTAssertEqual(off.descriptor["reasoning"]?.boolValue, false)
    }

    func testModelsWithoutCodingToolsStillResolveTheirProvider() throws {
        let model = Self.model(provider: "openai", model: "gpt-4o", apiKey: "key", toolUsage: 0)
        let result = try Self.build(model: model)
        XCTAssertEqual(result.descriptor["providerId"]?.stringValue, "openai")
    }

    private static func build(
        model: NativeModel,
        profile: NativeModelProfile? = nil,
        encrypted: Bool = false,
        reasoningEffort: String? = nil,
        tinfoilUserBaseURL: URL? = nil,
        reasoning: NativeReasoningResolution? = nil
    ) throws -> NativePiModelDescriptor {
        let runtime = NativeModelRuntimeConfiguration(
            model: model,
            profile: profile,
            reasoningEffort: reasoningEffort ?? model.reasoningEffort,
            isConfidentialThread: encrypted
        )
        return try NativePiModelDescriptor.build(
            runtime: runtime,
            backendURL: URL(string: "https://api.example.test/v1")!,
            token: "session-token",
            deviceID: "device-1",
            tinfoilUserBaseURL: tinfoilUserBaseURL,
            reasoning: reasoning
        )
    }

    private static func model(
        provider: String,
        model: String,
        vendor: String? = nil,
        url: String? = nil,
        apiKey: String? = nil,
        providerConnectionID: String? = nil,
        connectionAuthMethod: String? = nil,
        isSystem: Int64 = 0,
        isConfidential: Int64 = 0,
        contextWindow: Int64? = nil,
        toolUsage: Int64 = 1,
        reasoningEffort: String? = nil
    ) -> NativeModel {
        NativeModel(
            id: "model-1", provider: provider, name: "Test", model: model, url: url,
            providerConnectionID: providerConnectionID, connectionAuthMethod: connectionAuthMethod,
            isSystem: isSystem, enabled: 1, toolUsage: toolUsage, isConfidential: isConfidential,
            startWithReasoning: 0, reasoningEffort: reasoningEffort, supportsParallelToolCalls: 1,
            contextWindow: contextWindow, deletedAt: nil, defaultHash: nil, vendor: vendor,
            description: nil, userID: "user-1", apiKey: apiKey, oauthProvider: nil, providerDefault: nil,
            connectionName: nil, connectionReady: true
        )
    }

    private static func profile(_ providerOptionsJSON: String) -> NativeModelProfile {
        NativeModelProfile(
            modelID: "model-1", temperature: nil, maxSteps: nil, maxAttempts: nil, nudgeThreshold: nil,
            useSystemMessageModeDeveloper: 0, toolsOverride: nil, linkPreviewsOverride: nil,
            chatModeAddendum: nil, searchModeAddendum: nil, researchModeAddendum: nil,
            citationReinforcementEnabled: 0, citationReinforcementPrompt: nil,
            nudgeFinalStep: nil, nudgePreventive: nil, nudgeRetry: nil,
            nudgeSearchFinalStep: nil, nudgeSearchPreventive: nil, nudgeSearchRetry: nil,
            providerOptionsJSON: providerOptionsJSON, defaultHash: nil, deletedAt: nil, userID: "user-1"
        )
    }
}
