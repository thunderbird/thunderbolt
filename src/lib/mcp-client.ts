/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMCPClient } from '@ai-sdk/mcp'
import { getMcpServerCredentials, type McpServerCredentials } from '@/dal/mcp-secrets'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getAuthToken } from './auth-token'
import type { HttpClient } from './http'
import { ensureValidMcpOAuthToken } from './mcp-auth/ensure-valid-token'
import { buildMcpHeaders, createMcpTransport, type MCPTransportType } from './mcp-transport'
import { createProxyFetch } from './proxy-fetch'

/**
 * Resolve a server's bearer token, refreshing OAuth credentials through the
 * authenticated proxy when necessary. The refresh function is injectable for
 * tests; production shares the existing token-refresh deduplication.
 */
export const resolveMcpAccessToken = async (
  db: AnyDrizzleDatabase,
  serverId: string,
  credentials: McpServerCredentials | null,
  cloudUrl: string,
  ensureValidToken: typeof ensureValidMcpOAuthToken = ensureValidMcpOAuthToken,
): Promise<string | undefined> => {
  if (credentials?.type === 'bearer') {
    return credentials.token
  }
  if (credentials?.type === 'oauth') {
    const fetchFn = createProxyFetch({
      cloudUrl,
      getProxyAuthToken: getAuthToken,
    })
    return ensureValidToken(db, serverId, fetchFn)
  }
  return undefined
}

type ConnectMcpClientOptions = {
  db: AnyDrizzleDatabase
  httpClient: HttpClient
  serverId: string
  url: string
  type: MCPTransportType
  cloudUrl: string
}

/** Connect using freshly read credentials so reconnects pick up token rotation. */
export const connectMcpClient = async ({ db, httpClient, serverId, url, type, cloudUrl }: ConnectMcpClientOptions) => {
  const credentials = await getMcpServerCredentials(db, serverId)
  const token = await resolveMcpAccessToken(db, serverId, credentials, cloudUrl)
  const headers = buildMcpHeaders(token)
  const transport = createMcpTransport(url, type, cloudUrl, headers, httpClient)
  return createMCPClient({ transport })
}
