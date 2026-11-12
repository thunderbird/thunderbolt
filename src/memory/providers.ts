/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const memoryMcpProviders = [
  {
    id: 'supermemory',
    name: 'Supermemory',
    url: 'https://mcp.supermemory.ai/mcp',
    documentationUrl: 'https://supermemory.ai/mcp/',
    bankScoped: false,
  },
  {
    id: 'mem0',
    name: 'Mem0',
    url: 'https://mcp.mem0.ai/mcp/',
    documentationUrl: 'https://docs.mem0.ai/platform/mem0-mcp',
    bankScoped: false,
  },
  {
    id: 'hindsight',
    name: 'Hindsight Cloud',
    url: 'https://api.hindsight.vectorize.io/mcp',
    documentationUrl: 'https://docs.hindsight.vectorize.io/cloud/mcp/',
    bankScoped: true,
  },
  {
    id: 'zep',
    name: 'Zep',
    url: 'https://api.getzep.com/mcp',
    documentationUrl: 'https://help.getzep.com/v4/context-mcp-server/connect',
    bankScoped: false,
  },
] as const

export type MemoryMcpProvider = (typeof memoryMcpProviders)[number]
export type MemoryMcpProviderId = MemoryMcpProvider['id']

/** Avoid Mem0's POST redirect without changing the saved URL used for connection identity. */
export const memoryMcpTransportUrl = (value: string): string => {
  const url = new URL(value)
  if (url.origin !== 'https://mcp.mem0.ai' || url.pathname !== '/mcp') {
    return value
  }
  url.pathname = '/mcp/'
  return url.href
}

/** Gate dedicated memory-service origins even when an endpoint uses an encoded or alternate path. */
export const getMemoryMcpProvider = (value: string | null | undefined): MemoryMcpProvider | undefined => {
  if (!value) {
    return undefined
  }
  try {
    const url = new URL(value)
    return memoryMcpProviders.find((provider) => {
      const endpoint = new URL(provider.url)
      return url.origin === endpoint.origin
    })
  } catch {
    return undefined
  }
}

/** Require an explicit bank so a Hindsight connection never silently creates a default bank. */
export const memoryMcpServerUrl = (provider: MemoryMcpProvider, bankId = ''): string => {
  if (!provider.bankScoped) {
    return provider.url
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(bankId)) {
    throw new Error('Enter a memory bank ID using letters, numbers, hyphens, or underscores')
  }
  return `${provider.url}/${encodeURIComponent(bankId)}/`
}
