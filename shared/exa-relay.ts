/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Exa's OAuth endpoints do not support browser CORS; only these fixed targets may be relayed. */
export const exaRelayEndpoints: Record<string, { url: string; methods: readonly string[] }> = {
  '/_exa/resource': { url: 'https://mcp.exa.ai/.well-known/oauth-protected-resource/mcp/oauth', methods: ['GET'] },
  '/_exa/resource-root': { url: 'https://mcp.exa.ai/.well-known/oauth-protected-resource', methods: ['GET'] },
  '/_exa/authorization-server': { url: 'https://auth.exa.ai/.well-known/oauth-authorization-server', methods: ['GET'] },
  '/_exa/openid': { url: 'https://auth.exa.ai/.well-known/openid-configuration', methods: ['GET'] },
  '/_exa/register': { url: 'https://auth.exa.ai/api/oauth/register', methods: ['POST'] },
  '/_exa/token': { url: 'https://auth.exa.ai/api/oauth/token', methods: ['POST'] },
  '/_exa/revoke': { url: 'https://auth.exa.ai/api/oauth/revoke', methods: ['POST'] },
  '/_exa/mcp': { url: 'https://mcp.exa.ai/mcp/oauth', methods: ['GET', 'POST', 'DELETE'] },
}

/** Keeps OAuth resource/issuer identities external while routing browser HTTP through the frontend. */
export const exaBrowserRelayUrl = (url: URL): string | undefined => {
  const entry = Object.entries(exaRelayEndpoints).find(
    ([, endpoint]) => endpoint.url === `${url.origin}${url.pathname}`,
  )
  return entry ? `${entry[0]}${url.search}` : undefined
}
