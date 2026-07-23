/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useMemo } from 'react'
import { useQuery as useReactQuery } from '@tanstack/react-query'

import { getMcpServerCredentialRows, getRemoteMcpServers, parseMcpCredentialSummary } from '@/dal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { StoredCredentialType } from '@/lib/mcp-auth/auth-decision'
import type { MCPClient, MCPServerConnection } from '@/lib/mcp-provider'

type ServerTools = Record<string, string[]>
type CredentialSummary = { type: StoredCredentialType; bearerToken?: string }

const clientGenerations = new WeakMap<MCPClient, number>()
const clientGenerationCounter = { current: 0 }

const clientGenerationOf = (client: MCPClient): number => {
  const existing = clientGenerations.get(client)
  if (existing !== undefined) {
    return existing
  }
  clientGenerationCounter.current += 1
  clientGenerations.set(client, clientGenerationCounter.current)
  return clientGenerationCounter.current
}

/** Loads persisted MCP rows, credential summaries, and live tool names. */
export const useMcpServersData = (db: AnyDrizzleDatabase, connections: MCPServerConnection[]) => {
  const { data: servers = [] } = useQuery({
    queryKey: ['mcp-servers'],
    query: toCompilableQuery(getRemoteMcpServers(db)),
  })
  const { data: secrets = [] } = useQuery({
    queryKey: ['mcp-secrets'],
    query: toCompilableQuery(getMcpServerCredentialRows(db)),
  })
  const credentialsById = useMemo(
    () =>
      secrets.reduce<Record<string, CredentialSummary>>((summaries, row) => {
        const credential = parseMcpCredentialSummary(row)
        if (!credential) {
          return summaries
        }
        summaries[row.id] =
          credential.type === 'bearer'
            ? { type: 'bearer', bearerToken: credential.bearerToken }
            : { type: credential.type }
        return summaries
      }, {}),
    [secrets],
  )

  const connectedServers = connections
    .flatMap((server) => (server.isConnected && server.client ? [{ id: server.id, client: server.client }] : []))
    .sort((left, right) => left.id.localeCompare(right.id))
  const { data: serverTools = {} } = useReactQuery<ServerTools>({
    queryKey: ['mcp-server-tools', connectedServers.map(({ id, client }) => `${id}:${clientGenerationOf(client)}`)],
    enabled: connectedServers.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        connectedServers.map(async ({ id, client }): Promise<[string, string[]]> => {
          try {
            return [id, Object.keys(await client.tools())]
          } catch (error) {
            console.error('Failed to fetch tools for server:', id, error)
            return [id, []]
          }
        }),
      )
      return Object.fromEntries(entries)
    },
  })

  return { servers, credentialsById, serverTools }
}
