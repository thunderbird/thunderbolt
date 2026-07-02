/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Setup detail the ACP registry doesn't carry: the API-key environment variables
 * an agent needs and where to read its setup docs. The run command itself is
 * always derived from the registry's `distribution` (see `buildRunCommand`), so
 * this map holds *only* the fields the registry lacks.
 *
 * Keyed by `RegistryEntry.id`. Only agents with an authored entry show the richer
 * setup panel; every other agent falls back to the copy-command-only view.
 */
export type AgentInstallMeta = {
  requiredEnv?: ReadonlyArray<{ name: string; description: string }>
  docsUrl?: string
  setupNote?: string
}

export const agentInstallMetadata: Readonly<Record<string, AgentInstallMeta>> = {
  gemini: {
    requiredEnv: [{ name: 'GEMINI_API_KEY', description: 'API key from Google AI Studio.' }],
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  'claude-acp': {
    requiredEnv: [{ name: 'ANTHROPIC_API_KEY', description: 'API key from the Anthropic Console.' }],
    docsUrl: 'https://github.com/agentclientprotocol/claude-agent-acp',
  },
  'codex-acp': {
    requiredEnv: [{ name: 'OPENAI_API_KEY', description: 'API key from the OpenAI Platform.' }],
    docsUrl: 'https://github.com/zed-industries/codex-acp',
  },
  'grok-build': {
    requiredEnv: [{ name: 'XAI_API_KEY', description: 'API key from the xAI Console.' }],
    docsUrl: 'https://x.ai/cli',
  },
  'mistral-vibe': {
    requiredEnv: [{ name: 'MISTRAL_API_KEY', description: 'API key from La Plateforme.' }],
    docsUrl: 'https://mistral.ai/products/vibe',
  },
}
