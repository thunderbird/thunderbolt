/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CloudConnectionConfig } from '@shared/cloud-agent/contracts'
import type { McpServer } from '@/types'
import type { CloudConnectionView } from './client'

export type CloudLibrarySource = {
  kind: 'mcp' | 'model'
  id: string
  name: string
  url: string
  contextWindow?: number
}
export type CloudMcpUnavailableReason =
  | 'transport'
  | 'endpoint'
  | 'unbound'
  | 'ambiguous'
  | 'changed'
  | 'disabled'
  | 'authorization'
export type CloudMcpLibraryEntry = {
  server: McpServer
  source: CloudLibrarySource
  connection?: CloudConnectionView
  cloudConnectionId?: string
  eligible: boolean
  ready: boolean
  definitionChanged: boolean
  reason?: CloudMcpUnavailableReason
}

/** Match stable library identity only; matching names or URLs never confers cloud access. */
export const findCloudLibraryBinding = (
  source: Pick<CloudLibrarySource, 'kind' | 'id'>,
  connections: CloudConnectionView[],
): CloudConnectionView | undefined => {
  const matches = cloudLibraryBindings(source, connections)
  const enabled = matches.filter(({ record }) => record.enabled)
  return enabled.length === 1 ? enabled[0] : matches.length === 1 ? matches[0] : undefined
}

/** Keep duplicate grants visible instead of silently choosing another credential. */
export const cloudLibraryBindings = (
  source: Pick<CloudLibrarySource, 'kind' | 'id'>,
  connections: CloudConnectionView[],
): CloudConnectionView[] =>
  connections.filter(
    ({ config, record }) =>
      !record.deletedAt &&
      config.kind === source.kind &&
      config.libraryRef?.kind === source.kind &&
      config.libraryRef.id === source.id,
  )

/** UI eligibility is conservative; the backend also resolves and pins public DNS on every request. */
export const isCloudPublicEndpoint = (value: string): boolean => {
  if (!URL.canParse(value)) {
    return false
  }
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    return false
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false
  }
  if (host.includes(':')) {
    return false
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number)
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return false
    }
  }
  return true
}

/** The local enabled switch controls this device; cloud authorization is an independent explicit choice. */
export const getCloudMcpBinding = (server: McpServer, connections: CloudConnectionView[]): CloudMcpLibraryEntry => {
  const source: CloudLibrarySource = { kind: 'mcp', id: server.id, name: server.name, url: server.url ?? '' }
  const matches = cloudLibraryBindings(source, connections)
  const connection = findCloudLibraryBinding(source, connections)
  const definitionChanged = !!connection && connection.config.url !== source.url
  const reason: CloudMcpUnavailableReason | undefined =
    server.type !== 'http'
      ? 'transport'
      : !isCloudPublicEndpoint(source.url)
        ? 'endpoint'
        : matches.length > 1 && !connection
          ? 'ambiguous'
          : !connection
            ? 'unbound'
            : definitionChanged
              ? 'changed'
              : !connection.record.enabled
                ? 'disabled'
                : connection.record.status !== 'ready'
                  ? 'authorization'
                  : undefined
  return {
    server,
    source,
    connection,
    cloudConnectionId: connection?.record.id,
    eligible: server.type === 'http' && isCloudPublicEndpoint(source.url),
    ready: !reason,
    definitionChanged,
    reason,
  }
}

/** Freeze the library definition at authorization, never copying a device token into a cloud grant. */
export const cloudConfigFromLibrary = (
  source: CloudLibrarySource,
  previous?: CloudConnectionConfig,
): CloudConnectionConfig => ({
  name: source.name,
  kind: source.kind,
  url: source.url,
  libraryRef: { kind: source.kind, id: source.id },
  authentication:
    previous?.url === source.url && previous.kind === source.kind ? previous.authentication : { type: 'none' },
  ...(source.kind === 'mcp' && previous?.allowedTools ? { allowedTools: previous.allowedTools } : {}),
  ...(source.kind === 'model'
    ? {
        modelLimits: previous?.modelLimits ?? {
          contextWindow: source.contextWindow ?? 128000,
          maxOutputTokens: 8192,
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
        },
      }
    : {}),
})
