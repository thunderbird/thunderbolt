/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import type { McpServerCredentials } from '@/dal/mcp-secrets'
import { nativeFetch } from '@/lib/native-fetch'
import { isTauri } from '@/lib/platform'
import { exaBrowserRelayUrl } from '@shared/exa-relay'
import { createOAuthRequestSignal } from '@/lib/openrouter-auth'
import type { ProviderCredentials } from './types'

export const searchMcpUrls = {
  exa: 'https://mcp.exa.ai/mcp/oauth',
  tavily: 'https://mcp.tavily.com/mcp/',
} as const
export type McpSearchProvider = keyof typeof searchMcpUrls

/** Recognizes only provider-owned MCP handshakes, keeping ordinary server OAuth separate. */
export const getMcpSearchProvider = (id: string | null): McpSearchProvider | undefined =>
  id === 'oauth:exa' ? 'exa' : id === 'oauth:tavily' ? 'tavily' : undefined

/** Native apps connect directly; browser Exa requests use the fixed same-origin relay. */
export const searchOAuthFetch = (signal?: AbortSignal): typeof globalThis.fetch =>
  Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const target = !isTauri() ? exaBrowserRelayUrl(url) : undefined
      const request =
        target && input instanceof Request
          ? new Request(new URL(target, window.location.origin), input)
          : (target ?? input)
      return (isTauri() ? nativeFetch : globalThis.fetch)(request, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        signal: createOAuthRequestSignal(
          AbortSignal.any([
            ...(signal ? [signal] : []),
            ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : []),
          ]),
        ),
      })
    },
    { preconnect: () => Promise.resolve(false) },
  )

/** Keeps the discovered issuer, resource and client binding with device-local provider credentials. */
export const mcpSearchCredentials = (
  provider: McpSearchProvider,
  credentials: Extract<McpServerCredentials, { type: 'oauth' }>,
): ProviderCredentials => {
  if (!credentials.clientId || !credentials.issuer || !credentials.tokenEndpoint) {
    throw new Error('Incomplete MCP OAuth session')
  }
  return {
    access_token: credentials.access_token,
    refresh_token: credentials.refresh_token,
    expires_at: credentials.expires_at,
    oauth: {
      clientId: credentials.clientId,
      issuer: credentials.issuer,
      tokenEndpoint: credentials.tokenEndpoint,
      resource: resourceUrlFromServerUrl(searchMcpUrls[provider]).href,
      scope: credentials.scope,
    },
  }
}
