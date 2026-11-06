/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const providerTypes = [
  'openai',
  'anthropic',
  'custom',
  'openrouter',
  'tinfoil',
  'otari',
  'exa',
  'brave',
  'tavily',
] as const
export type ProviderType = (typeof providerTypes)[number]
export type OAuthProviderType = 'openrouter' | 'tinfoil' | 'otari' | 'openai' | 'exa' | 'tavily'
export type ProviderAuthMethod = 'oauth' | 'api_key'
export type ProviderCapability = 'models' | 'search'
export type ChatGPTRegistration = { clientId: string; subject?: string; email?: string; name?: string }
export type ProviderCredentials = {
  apiKey?: string
  access_token?: string
  refresh_token?: string
  expires_at?: number
  reauth_required?: boolean
  oauth?: {
    clientId: string
    issuer: string
    tokenEndpoint: string
    resource: string
    scope?: string
    subject?: string
    idToken?: string
    email?: string
    name?: string
  }
  chatGPTRegistration?: ChatGPTRegistration
  sessionRevision?: string
}
export type ProviderConnection = {
  id: string
  provider: ProviderType
  name: string
  url: string | null
  authMethod: ProviderAuthMethod
  enabled: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  userId: string | null
  connected: boolean
  needsConsent?: boolean
}
