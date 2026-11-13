/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

/// Keep in step with `shared/defaults/models.ts` and its versioned model-profile registry.
enum NativeModelDefaults {
    static let version: Double = 11
    static let defaultModelID = "01a06dd7-67ee-75be-b957-2b746271c49d"

    static let models: [NativeModelDefault] = [
        NativeModelDefault(
            id: "019af08a-c27b-7074-8aac-95315d1ef3fd", provider: "thunderbolt", name: "Opus 5.5",
            model: "opus-5-5", url: nil, isSystem: 1, enabled: 1, toolUsage: 1, isConfidential: 0,
            startWithReasoning: 0, supportsParallelToolCalls: 1, contextWindow: 1_000_000, deletedAt: nil,
            defaultHash: nil, vendor: "anthropic", description: "Top-tier Anthropic reasoning", userID: nil
        ),
        NativeModelDefault(
            id: "01a06dd7-67ee-75be-b957-2b746271c49d", provider: "tinfoil", name: "DeepSeek V4.1 Flash",
            model: "deepseek-v4-1-flash", url: nil, isSystem: 1, enabled: 1, toolUsage: 1, isConfidential: 1,
            startWithReasoning: 0, supportsParallelToolCalls: 0, contextWindow: 1_048_576, deletedAt: nil,
            defaultHash: nil, vendor: "deepseek", description: "Fast, low-cost confidential chat with image support", userID: nil
        ),
        NativeModelDefault(
            id: "019e7580-2b0e-719c-a43f-d2b56e7f31b4", provider: "tinfoil", name: "GLM 5.3",
            model: "glm-5-3", url: nil, isSystem: 1, enabled: 1, toolUsage: 1, isConfidential: 1,
            startWithReasoning: 0, supportsParallelToolCalls: 0, contextWindow: 131_072, deletedAt: nil,
            defaultHash: nil, vendor: "zhipu", description: "Confidential chat via Thunderbolt", userID: nil
        ),
    ]

    private static let confidentialToolsDeepSeek = [
        #"- After applying the verification and explicit-search rules above, answer established lists, historical examples and stable guidance from knowledge when the conclusion does not depend on today's facts, even if the question mentions this year. Do not add a current count, version or status just to justify a search; verify when the requested answer depends on today's status, access, price or version."#,
        #"- For those knowledge answers, give the requested examples or guidance first, then one explicit sentence saying changeable details may be outdated and offering to check an up-to-date source. Include the knowledge or estimate year and scope when known and relevant; dates attached to individual examples alone are not a freshness caveat."#,
        #"- For a standalone niche identity or function lookup outside research, verify the entity with one targeted search even if you recall a specific definition; fetch at most one page if needed, then answer from the evidence and state gaps; ask for user context only when it is needed to distinguish the intended entity."#,
        #"- For current weather or the next five days, load weather and resolve the place; ask if the place is ambiguous. Emit the skill's <widget:weather-forecast> tag with the resolved location attributes directly in your final response, outside code fences. The chat renders the tag and the widget fetches its own data; emitting it completes the request. Do not call render_html, search or fetch_content for this weather request."#,
        #"- For a narrow current-fact lookup, use an official source for the requested value and the fact's own date or observation time; fetch a page if that evidence is missing. If a volatile value still has no observation time, attribute it to the source, label any publication date as such (or say "source undated"), and state "observation time unavailable; not a live quote". Never substitute today's date or call that value current; if the requested fact itself is missing, state the gap instead of filling it from memory."#,
        #"- Use no web for analysis or transformation confined to user-supplied text, data or code, or for purely formal mathematical reasoning. For other factual questions with a premise you believe is false or outdated, run one targeted search for primary evidence of the corrected fact before answering, even if you recall the correction. Cite the correction's evidence; state any verification gap instead of presenting memory as verified."#,
        #"- Do not load research for a narrow fact, entity or value lookup. For broader requests needing external evidence from multiple sources, call skill({ name: "research" }) before the first search or fetch_content. In the final answer, name any unverified item or dimension and omit unsupported details instead of filling them from memory."#,
    ].joined(separator: "\n")

    private static let confidentialToolsGLM = [
        #"- After applying the verification and explicit-search rules above, answer established lists, historical examples and stable guidance from knowledge when the conclusion does not depend on today's facts, even if the question mentions this year. Do not add a current count, version or status just to justify a search; verify when the requested answer depends on today's status, access, price or version."#,
        #"- For those knowledge answers, give the requested examples or guidance first, then one explicit sentence saying changeable details may be outdated and offering to check an up-to-date source. Include the knowledge or estimate year and scope when known and relevant; dates attached to individual examples alone are not a freshness caveat."#,
        #"- For a standalone niche identity or function lookup outside research, verify the entity with one targeted search even if you recall a specific definition; fetch at most one page if needed, then answer from the evidence and state gaps; ask for user context only when it is needed to distinguish the intended entity."#,
        #"- For current weather or the next five days, load weather, resolve the place, and emit its widget directly in the final response; ask if the place is ambiguous. This completes the request without search or fetch_content."#,
        #"- For a narrow current-fact lookup, use an official source for the requested value and the fact's own date or observation time; fetch a page if that evidence is missing. If a volatile value still has no observation time, attribute it to the source, label any publication date as such (or say "source undated"), and state "observation time unavailable; not a live quote". Never substitute today's date or call that value current; if the requested fact itself is missing, state the gap instead of filling it from memory."#,
    ].joined(separator: "\n")

    static let profiles: [NativeModelProfileDefault] = [
        NativeModelProfileDefault(
            modelID: "019af08a-c27b-7074-8aac-95315d1ef3fd", temperature: nil, maxSteps: 20,
            maxAttempts: 2, nudgeThreshold: 6, useSystemMessageModeDeveloper: 0,
            toolsOverride: "- For a narrow current-fact lookup, use an official source for the requested value and the fact's own date or observation time; fetch a page if that evidence is missing. If a volatile value still has no observation time, attribute it to the source, label any publication date as such (or say \"source undated\"), and state \"observation time unavailable; not a live quote\". Never substitute today's date or call that value current; if the requested fact itself is missing, state the gap instead of filling it from memory.",
            linkPreviewsOverride: nil, chatModeAddendum: nil, searchModeAddendum: nil, researchModeAddendum: nil,
            citationReinforcementEnabled: 0, citationReinforcementPrompt: nil,
            nudgeFinalStep: nil, nudgePreventive: nil, nudgeRetry: nil,
            nudgeSearchFinalStep: nil, nudgeSearchPreventive: nil, nudgeSearchRetry: nil,
            providerOptionsJSON: nil, deletedAt: nil
        ),
        NativeModelProfileDefault(
            modelID: "01a06dd7-67ee-75be-b957-2b746271c49d", temperature: 0.2, maxSteps: 20,
            maxAttempts: 2, nudgeThreshold: 6, useSystemMessageModeDeveloper: 0,
            toolsOverride: confidentialToolsDeepSeek, linkPreviewsOverride: nil, chatModeAddendum: nil, searchModeAddendum: nil,
            researchModeAddendum: nil, citationReinforcementEnabled: 0, citationReinforcementPrompt: nil,
            nudgeFinalStep: nil, nudgePreventive: nil, nudgeRetry: nil,
            nudgeSearchFinalStep: nil, nudgeSearchPreventive: nil, nudgeSearchRetry: nil,
            providerOptionsJSON: "{\"reasoningEffort\":\"low\"}", deletedAt: nil
        ),
        NativeModelProfileDefault(
            modelID: "019e7580-2b0e-719c-a43f-d2b56e7f31b4", temperature: 0.2, maxSteps: 20,
            maxAttempts: 2, nudgeThreshold: 6, useSystemMessageModeDeveloper: 0,
            toolsOverride: confidentialToolsGLM, linkPreviewsOverride: nil, chatModeAddendum: nil, searchModeAddendum: nil,
            researchModeAddendum: nil, citationReinforcementEnabled: 0, citationReinforcementPrompt: nil,
            nudgeFinalStep: nil, nudgePreventive: nil, nudgeRetry: nil,
            nudgeSearchFinalStep: nil, nudgeSearchPreventive: nil, nudgeSearchRetry: nil,
            providerOptionsJSON: "{\"reasoningEffort\":\"max\"}", deletedAt: nil
        ),
    ]
}

struct NativeModelProfileDefault: Sendable, Equatable {
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
    let deletedAt: String?
}
