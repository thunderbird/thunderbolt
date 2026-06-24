/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createClient, type HttpClient } from '@/lib/http'
import { describe, expect, it } from 'bun:test'
import type { GithubAuthorizeUrlResponse, GithubStatusResponse } from './api'
import { createConfigs } from './tools'

const jsonClient = (
  body: GithubAuthorizeUrlResponse | GithubStatusResponse,
  capture?: (url: string) => void,
): HttpClient =>
  createClient({
    prefixUrl: 'http://test-api.local/v1',
    fetch: async (input) => {
      capture?.(input instanceof Request ? input.url : String(input))
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

const tool = (client: HttpClient, name: 'github_connect' | 'github_status') => {
  const config = createConfigs(client).find((t) => t.name === name)
  if (!config) {
    throw new Error(`tool ${name} not found`)
  }
  return config
}

describe('createConfigs', () => {
  it('exposes github_connect and github_status with empty (no-arg) schemas', () => {
    const configs = createConfigs(jsonClient({ configured: false }))
    expect(configs.map((c) => c.name).sort()).toEqual(['github_connect', 'github_status'])
    // No model-supplied args: the parameters schema accepts only an empty object.
    for (const c of configs) {
      expect(c.parameters.safeParse({}).success).toBe(true)
      expect(c.parameters.safeParse({ user_id: 'someone-else' }).success).toBe(false)
    }
  })
})

describe('github_connect', () => {
  it('hits the backend authorize-url endpoint and returns a clickable connect message', async () => {
    let calledUrl = ''
    const client = jsonClient(
      { configured: true, status: 'ok', url: 'https://github.com/login/oauth/authorize?state=x' },
      (u) => (calledUrl = u),
    )
    const result = await tool(client, 'github_connect').execute({})
    expect(calledUrl).toContain('/coding-agent/github/authorize-url')
    expect(result).toEqual({
      url: 'https://github.com/login/oauth/authorize?state=x',
      message: 'Connect your GitHub: https://github.com/login/oauth/authorize?state=x',
    })
  })

  it('explains when the coding agent is not configured', async () => {
    const result = await tool(jsonClient({ configured: false }), 'github_connect').execute({})
    expect(result.connected).toBe(false)
    expect(result.message).toContain('not configured')
  })

  it('explains a disabled broker', async () => {
    const result = await tool(jsonClient({ configured: true, status: 'disabled' }), 'github_connect').execute({})
    expect(result.connected).toBe(false)
    expect(result.message).toContain('disabled')
  })

  it('explains a broker failure', async () => {
    const result = await tool(jsonClient({ configured: true, status: 'failed' }), 'github_connect').execute({})
    expect(result.connected).toBe(false)
    expect(result.message).toContain('try again')
  })
})

describe('github_status', () => {
  it('reports connected', async () => {
    let calledUrl = ''
    const client = jsonClient({ configured: true, status: 'ok', connected: true }, (u) => (calledUrl = u))
    const result = await tool(client, 'github_status').execute({})
    expect(calledUrl).toContain('/coding-agent/github/status')
    expect(result.connected).toBe(true)
    expect(result.message).toContain('connected')
  })

  it('reports not-connected and points at github_connect', async () => {
    const result = await tool(
      jsonClient({ configured: true, status: 'ok', connected: false }),
      'github_status',
    ).execute({})
    expect(result.connected).toBe(false)
    expect(result.message).toContain('github_connect')
  })

  it('explains not configured', async () => {
    const result = await tool(jsonClient({ configured: false }), 'github_status').execute({})
    expect(result.connected).toBe(false)
    expect(result.message).toContain('not configured')
  })

  it('explains a broker failure', async () => {
    const result = await tool(jsonClient({ configured: true, status: 'failed' }), 'github_status').execute({})
    expect(result.connected).toBe(false)
    expect(result.message).toContain('try again')
  })
})
