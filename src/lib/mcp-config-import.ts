/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { validateMcpServerUrl } from '@/lib/mcp-url-validation'
import { isRecord } from '@/lib/utils'

/** A remote MCP server parsed from an mcpServers JSON config. */
export type ParsedMcpServer = {
  name: string
  url: string
  transport: 'http' | 'sse'
  credential?: { type: 'bearer'; token: string }
  enabled: boolean
}

type ParseResult = { ok: true; servers: ParsedMcpServer[] } | { ok: false; errors: string[] }

const bearerPattern = /^Bearer\s+(.+)$/i

/** Returns the value as a server-entries record only when it is a non-empty object. */
const pickEntries = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) && Object.keys(value).length > 0 ? value : undefined

const resolveTransport = (type: unknown): 'http' | 'sse' => (type === 'http' || type === 'sse' ? type : 'http')

const extractBearerToken = (headers: unknown): string | undefined => {
  if (!isRecord(headers)) {
    return undefined
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')
  if (!entry || typeof entry[1] !== 'string') {
    return undefined
  }
  const match = entry[1].match(bearerPattern)
  return match ? match[1].trim() : undefined
}

/**
 * Parse a canonical MCP servers JSON config (`mcpServers` key, or the VS Code
 * `servers` variant) into normalized {@link ParsedMcpServer} entries.
 *
 * All-or-nothing: any malformed JSON, missing root key, unsupported stdio
 * entry, or invalid remote URL collects an error and the whole import fails.
 * Non-Bearer auth headers are silently ignored (the server is still parsed).
 */
export const parseMcpServersConfig = (text: string): ParseResult => {
  const parsed = ((): { ok: true; value: unknown } | { ok: false; message: string } => {
    try {
      return { ok: true, value: JSON.parse(text) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })()

  if (!parsed.ok) {
    return { ok: false, errors: [`Invalid JSON: ${parsed.message}`] }
  }

  const root = parsed.value
  if (!isRecord(root)) {
    return { ok: false, errors: ['Expected a JSON object with an "mcpServers" or "servers" key'] }
  }

  const entries = pickEntries(root.mcpServers) ?? pickEntries(root.servers)

  if (!entries) {
    return { ok: false, errors: ['No servers found: expected a non-empty "mcpServers" or "servers" object'] }
  }

  const errors: string[] = []
  const servers: ParsedMcpServer[] = []

  for (const [name, raw] of Object.entries(entries)) {
    if (!isRecord(raw)) {
      errors.push(`${name}: expected an object`)
      continue
    }

    if ('command' in raw || 'args' in raw) {
      errors.push(`${name}: local/stdio servers are not supported yet (coming in THU-575)`)
      continue
    }

    if (typeof raw.url !== 'string') {
      errors.push(`${name}: missing "url"`)
      continue
    }

    const validation = validateMcpServerUrl(raw.url)
    if (!validation.ok) {
      errors.push(`${name}: ${validation.reason}`)
      continue
    }

    const token = extractBearerToken(raw.headers)
    servers.push({
      name,
      url: raw.url,
      transport: resolveTransport(raw.type),
      credential: token ? { type: 'bearer', token } : undefined,
      enabled: raw.disabled !== true,
    })
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return { ok: true, servers }
}
