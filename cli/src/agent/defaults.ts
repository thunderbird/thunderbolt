/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Provider defaults and credential environment metadata shared by CLI setup. */

import type { BuiltinProvider } from './types.ts'

/** Default model backend when provider is omitted. */
export const DEFAULT_PROVIDER: BuiltinProvider = 'anthropic'

/** Default Anthropic model. */
export const DEFAULT_MODEL = 'claude-opus-4-8'

/** Default catalog model for each built-in provider. */
export const DEFAULT_MODELS: Readonly<Record<BuiltinProvider, string>> = {
  anthropic: DEFAULT_MODEL,
  openai: 'gpt-5.6-sol',
  google: 'gemini-3.1-pro-preview',
  xai: 'grok-build-0.1',
  deepseek: 'deepseek-v4-pro',
  zai: 'glm-5.2',
  mistral: 'devstral-medium-latest',
  groq: 'openai/gpt-oss-120b',
  openrouter: 'anthropic/claude-opus-4.8',
  moonshotai: 'kimi-k2.7-code',
  minimax: 'MiniMax-M3',
  cerebras: 'gpt-oss-120b',
  together: 'moonshotai/Kimi-K2.7-Code',
  fireworks: 'accounts/fireworks/models/kimi-k2p7-code',
}

/** Environment variables Pi checks for each exposed built-in provider. */
export const BUILTIN_PROVIDER_ENV_VARS: Readonly<Record<BuiltinProvider, readonly string[]>> = {
  anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY'],
  xai: ['XAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  zai: ['ZAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  groq: ['GROQ_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
}
