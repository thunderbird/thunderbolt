/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the coding-agent GitHub HTTP routes. They drive the Elysia app
 * via `.handle()` with a fake `auth` (in-memory `getSession`) and injected broker
 * seams — no bound port, no real broker, no DB. Asserts the discriminated DTOs
 * and, crucially, that the broker is called with the *session* user.id (not any
 * request-supplied id).
 */

import type { Auth } from '@/auth/elysia-plugin'
import { createTestSettings } from '@/test-utils/settings'
import { describe, expect, it } from 'bun:test'
import type { AuthorizeUrlResult, BrokerGithubOptions, GithubStatusResult } from './github'
import { createCodingAgentGithubRoutes, type CodingAgentGithubDeps } from './github-routes'

const sessionUser = (id: string) =>
  ({ api: { getSession: async () => ({ user: { id, isAnonymous: false } }) } }) as unknown as Auth
const noSession = { api: { getSession: async () => null } } as unknown as Auth

const brokerSettings = createTestSettings({
  codingAgentBrokerUrl: 'https://broker.test',
  codingAgentServiceToken: 'svc',
})

const get = (app: ReturnType<typeof createCodingAgentGithubRoutes>, path: string) =>
  app.handle(new Request(`http://localhost${path}`, { headers: { Authorization: 'Bearer end-user-tok' } }))

describe('GET /coding-agent/github/authorize-url', () => {
  it('401s without a session', async () => {
    const app = createCodingAgentGithubRoutes(brokerSettings, noSession)
    const res = await get(app, '/coding-agent/github/authorize-url')
    expect(res.status).toBe(401)
  })

  it('returns configured:false when the broker is not configured', async () => {
    const app = createCodingAgentGithubRoutes(createTestSettings(), sessionUser('u1'))
    const res = await get(app, '/coding-agent/github/authorize-url')
    expect(await res.json()).toEqual({ configured: false })
  })

  it('returns the url and calls the broker with the SESSION user.id', async () => {
    let seenUserId = ''
    const deps: CodingAgentGithubDeps = {
      fetchAuthorizeUrlFn: async (_opts: BrokerGithubOptions, userId: string): Promise<AuthorizeUrlResult> => {
        seenUserId = userId
        return { status: 'ok', url: 'https://github.com/login/oauth/authorize?state=x' }
      },
    }
    const app = createCodingAgentGithubRoutes(brokerSettings, sessionUser('alice'), deps)
    const res = await get(app, '/coding-agent/github/authorize-url')
    expect(await res.json()).toEqual({
      configured: true,
      status: 'ok',
      url: 'https://github.com/login/oauth/authorize?state=x',
    })
    expect(seenUserId).toBe('alice') // identity comes from the session, not the request
  })

  it('maps a disabled broker to status:disabled', async () => {
    const app = createCodingAgentGithubRoutes(brokerSettings, sessionUser('u1'), {
      fetchAuthorizeUrlFn: async () => ({ status: 'disabled' }),
    })
    const res = await get(app, '/coding-agent/github/authorize-url')
    expect(await res.json()).toEqual({ configured: true, status: 'disabled' })
  })

  it('maps a broker failure to status:failed (no reason leaked to the client)', async () => {
    const app = createCodingAgentGithubRoutes(brokerSettings, sessionUser('u1'), {
      fetchAuthorizeUrlFn: async () => ({ status: 'failed', reason: 'broker 502' }),
    })
    const res = await get(app, '/coding-agent/github/authorize-url')
    expect(await res.json()).toEqual({ configured: true, status: 'failed' })
  })
})

describe('GET /coding-agent/github/status', () => {
  it('401s without a session', async () => {
    const app = createCodingAgentGithubRoutes(brokerSettings, noSession)
    const res = await get(app, '/coding-agent/github/status')
    expect(res.status).toBe(401)
  })

  it('returns configured:false when the broker is not configured', async () => {
    const app = createCodingAgentGithubRoutes(createTestSettings(), sessionUser('u1'))
    const res = await get(app, '/coding-agent/github/status')
    expect(await res.json()).toEqual({ configured: false })
  })

  it('reports connected:true and passes the session user.id', async () => {
    let seenUserId = ''
    const app = createCodingAgentGithubRoutes(brokerSettings, sessionUser('bob'), {
      fetchGithubStatusFn: async (_opts: BrokerGithubOptions, userId: string): Promise<GithubStatusResult> => {
        seenUserId = userId
        return { status: 'ok', connected: true }
      },
    })
    const res = await get(app, '/coding-agent/github/status')
    expect(await res.json()).toEqual({ configured: true, status: 'ok', connected: true })
    expect(seenUserId).toBe('bob')
  })

  it('reports connected:false', async () => {
    const app = createCodingAgentGithubRoutes(brokerSettings, sessionUser('u1'), {
      fetchGithubStatusFn: async () => ({ status: 'ok', connected: false }),
    })
    const res = await get(app, '/coding-agent/github/status')
    expect(await res.json()).toEqual({ configured: true, status: 'ok', connected: false })
  })

  it('maps a broker failure to status:failed', async () => {
    const app = createCodingAgentGithubRoutes(brokerSettings, sessionUser('u1'), {
      fetchGithubStatusFn: async () => ({ status: 'failed', reason: 'broker timeout' }),
    })
    const res = await get(app, '/coding-agent/github/status')
    expect(await res.json()).toEqual({ configured: true, status: 'failed' })
  })
})
