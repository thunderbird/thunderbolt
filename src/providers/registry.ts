/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultOtariOrigin, getOtariEndpoints } from '@/lib/otari-auth'
import type { ProviderCapability, ProviderType } from './types'

export type ProviderDefinition = {
  id: ProviderType
  name: string
  capabilities: readonly ProviderCapability[]
  oauth: boolean
  requiresUrl: boolean
  defaultUrl?: string
}

export const providerDefinitions: readonly ProviderDefinition[] = [
  { id: 'tinfoil', name: 'Tinfoil', capabilities: ['models', 'search'], oauth: true, requiresUrl: false },
  {
    id: 'otari',
    name: 'Otari',
    capabilities: ['models', 'search'],
    oauth: true,
    requiresUrl: true,
    defaultUrl: getOtariEndpoints(defaultOtariOrigin).inference,
  },
  { id: 'openrouter', name: 'OpenRouter', capabilities: ['models'], oauth: true, requiresUrl: false },
  { id: 'openai', name: 'OpenAI', capabilities: ['models'], oauth: true, requiresUrl: false },
  { id: 'anthropic', name: 'Anthropic', capabilities: ['models'], oauth: false, requiresUrl: false },
  { id: 'custom', name: 'OpenAI-compatible', capabilities: ['models'], oauth: false, requiresUrl: true },
  { id: 'exa', name: 'Exa', capabilities: ['search'], oauth: true, requiresUrl: false },
  { id: 'brave', name: 'Brave', capabilities: ['search'], oauth: false, requiresUrl: false },
  { id: 'tavily', name: 'Tavily', capabilities: ['search'], oauth: true, requiresUrl: false },
]

/** Capability metadata describes adapters available in this app, not account entitlements. */
export const getProviderDefinition = (provider: ProviderType): ProviderDefinition => {
  const definition = providerDefinitions.find(({ id }) => id === provider)
  if (!definition) {
    throw new Error(`Unknown provider: ${provider}`)
  }
  return definition
}
