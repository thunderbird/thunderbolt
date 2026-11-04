/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { cloudConnectionScope } from '@shared/cloud-agent/contracts'
import {
  decryptScopedJson,
  encryptScopedJson,
  generateResourceIdentity,
  generateResourceKey,
  sealResourceKey,
  type ResourceIdentity,
} from '@shared/cloud-agent/crypto'
import { createAuth } from '../auth/auth'
import { session, user } from '../db/auth-schema'
import { devicesTable } from '../db/powersync-schema'
import { createAppVersionMiddleware } from '../middleware/app-version'
import { signTestToken } from '../test-utils/auth-token'
import { cloudConnectionOAuth, cloudConnections } from '../db/cloud-agent-schema'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '../test-utils/db'
import { readCloudSettings } from './config'
import { createCloudOAuth, createCloudOAuthFetch, createCloudOAuthRoutes } from './oauth'
import { createCloudAgentService } from './service'

let testDb: IsolatedTestDb
let runtimeIdentity: ResourceIdentity
beforeAll(async () => {
  testDb = await getSharedIsolatedTestDb()
  runtimeIdentity = await generateResourceIdentity()
}, 60_000)
const callback = 'https://api.example.test/v1/cloud-agents/oauth/callback'
const issuer = 'https://issuer.example.test'
const resource = 'https://tools.example.test/mcp'
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  authorization_response_iss_parameter_supported: true,
}

/** Fake HTTP responses exercise the real SDK discovery, registration, PKCE and exchange code. */
const fixture = async () => {
  const ownerId = crypto.randomUUID()
  const connectionId = crypto.randomUUID()
  await testDb.db.insert(user).values({ id: ownerId, email: `${ownerId}@example.test`, name: 'OAuth owner' })
  const key = await generateResourceKey()
  const context = { ownerId, scopeId: cloudConnectionScope(connectionId), keyEpoch: 1 }
  const config = await encryptScopedJson(
    { name: 'Cloud connection', kind: 'mcp', url: resource, authentication: { type: 'none' } },
    key,
    { ...context, recordId: 'config', purpose: 'connection-config' },
  )
  const envelope = await sealResourceKey(key, runtimeIdentity.publicKey, {
    ...context,
    recipientId: runtimeIdentity.publicKey.keyId,
  })
  await testDb.db.insert(cloudConnections).values({
    id: connectionId,
    userId: ownerId,
    keyEpoch: 1,
    config,
    ownerKeyEnvelope: envelope,
    runtimeKeyEnvelope: envelope,
  })
  const settings = readCloudSettings({
    CLOUD_AGENTS_ENABLED: 'true',
    CLOUD_AGENT_RUNTIME_IDENTITY: JSON.stringify(runtimeIdentity),
    CLOUD_AGENT_OAUTH_CALLBACK_URL: callback,
    CLOUD_AGENT_OAUTH_RETURN_URL: 'https://app.example.test/settings/cloud-agents',
  })
  const service = createCloudAgentService(testDb.db, settings)
  const calls: { host: string; path: string; body: string }[] = []
  const changes: {
    metadata?: typeof metadata
    failTokens?: boolean
    beforeToken?: () => Promise<void>
    refreshCount: number
    exchangeCount: number
  } = { refreshCount: 0, exchangeCount: 0 }
  const clock = { date: new Date() }
  const request = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const req = new Request(input, init)
    const host = req.headers.get('host') ?? ''
    const path = new URL(req.url).pathname
    const body = await req.text()
    calls.push({ host, path, body })
    if (host === 'tools.example.test' && path.includes('/.well-known/oauth-protected-resource')) {
      return Response.json({ resource, authorization_servers: [issuer], scopes_supported: ['read', 'write'] })
    }
    if (host === 'issuer.example.test' && path === '/.well-known/oauth-authorization-server') {
      return Response.json(changes.metadata ?? metadata)
    }
    if (host === 'issuer.example.test' && path === '/register') {
      return Response.json(
        {
          client_id: 'independent-cloud-client',
          token_endpoint_auth_method: 'none',
          redirect_uris: [callback],
          response_types: ['code'],
          grant_types: ['authorization_code', 'refresh_token'],
        },
        { status: 201 },
      )
    }
    if (host === 'issuer.example.test' && path === '/token') {
      const params = new URLSearchParams(body)
      if (params.get('grant_type') === 'refresh_token') {
        changes.refreshCount += 1
      } else {
        changes.exchangeCount += 1
      }
      await changes.beforeToken?.()
      if (changes.failTokens) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      return Response.json({
        access_token: `cloud-access-${changes.exchangeCount}-${changes.refreshCount}`,
        token_type: 'Bearer',
        refresh_token: `cloud-refresh-${changes.refreshCount}`,
        expires_in: 3600,
      })
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
  const network = {
    fetchFn: Object.assign(request, { preconnect: () => {} }),
    dnsLookup: async () => [{ address: '1.1.1.1', family: 4 }],
    now: () => clock.date,
  }
  const oauth = createCloudOAuth(service, network)
  const start = async () => {
    const result = await oauth.start(ownerId, connectionId)
    return { ...result, state: new URL(result.authorizationUrl).searchParams.get('state')! }
  }
  const authorize = async () => {
    const started = await start()
    await oauth.complete({ state: started.state, code: 'authorization-code', iss: issuer })
    return started
  }
  return {
    ownerId,
    connectionId,
    key,
    context,
    settings,
    service,
    oauth,
    start,
    authorize,
    calls,
    changes,
    clock,
    network,
  }
}

describe('cloud OAuth authorization', () => {
  it('denies anonymous discovery and callback exchange for an ineligible owner', async () => {
    const f = await fixture()
    await testDb.db.update(user).set({ isAnonymous: true }).where(eq(user.id, f.ownerId))
    await expect(f.start()).rejects.toMatchObject({ code: 'cloud_account_required' })
    expect(f.calls).toHaveLength(0)
    await testDb.db.update(user).set({ isAnonymous: false }).where(eq(user.id, f.ownerId))
    const started = await f.start()
    await testDb.db.update(user).set({ isAnonymous: true }).where(eq(user.id, f.ownerId))
    await expect(f.oauth.complete({ state: started.state, code: 'code', iss: issuer })).rejects.toMatchObject({
      code: 'cloud_account_required',
    })
    expect(f.changes.exchangeCount).toBe(0)
  })

  it('uses independent registration, encrypted PKCE state and exact issuer/resource/redirect bindings', async () => {
    const f = await fixture()
    const started = await f.start()
    const url = new URL(started.authorizationUrl)
    expect(url.searchParams.get('redirect_uri')).toBe(callback)
    expect(url.searchParams.get('resource')).toBe(resource)
    expect(url.searchParams.get('scope')).toBe('read write')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('client_id')).toBe('independent-cloud-client')
    const [pending] = await testDb.db
      .select()
      .from(cloudConnectionOAuth)
      .where(eq(cloudConnectionOAuth.connectionId, f.connectionId))
    expect(JSON.stringify(pending)).not.toContain(started.state)
    expect(JSON.stringify(pending)).not.toContain('verifier')
    const secret = await decryptScopedJson(pending!.payload, f.key, {
      ...f.context,
      recordId: pending!.stateDigest,
      purpose: 'connection-oauth-pending',
    })
    expect(secret).toHaveProperty('state', started.state)
    await f.oauth.complete({ state: started.state, code: 'authorization-code', iss: issuer })
    const request = new URLSearchParams(f.calls.find((call) => call.path === '/token')!.body)
    const challenge = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.get('code_verifier')!)),
    ).toString('base64url')
    expect(challenge).toBe(url.searchParams.get('code_challenge')!)
    expect(request.get('redirect_uri')).toBe(callback)
    expect(request.get('resource')).toBe(resource)
    const row = await f.service.getConnection(f.ownerId, f.connectionId)
    expect(row.status).toBe('ready')
    expect(JSON.stringify(row)).not.toContain('cloud-access')
    expect((await f.service.openConnection(row)).config.authentication).toMatchObject({
      type: 'oauth',
      issuer,
      resource,
      clientId: 'independent-cloud-client',
      accessToken: 'cloud-access-1-0',
    })
    await expect(f.oauth.complete({ state: started.state, code: 'authorization-code', iss: issuer })).rejects.toThrow(
      'oauth_state_invalid',
    )
    expect(f.changes.exchangeCount).toBe(1)
  })

  it('rejects missing/wrong state, issuer and expired callbacks without exchanging a code', async () => {
    const f = await fixture()
    const first = await f.start()
    await expect(f.oauth.complete({ state: '', code: 'code', iss: issuer })).rejects.toThrow('oauth_state_invalid')
    await expect(
      f.oauth.complete({
        state: `${first.state.slice(0, 42)}${first.state.endsWith('A') ? 'B' : 'A'}`,
        code: 'code',
        iss: issuer,
      }),
    ).rejects.toThrow('oauth_state_invalid')
    await expect(
      f.oauth.complete({ state: first.state, code: 'code', iss: 'https://other.example.test' }),
    ).rejects.toThrow('oauth_callback_mismatch')
    await expect(f.oauth.complete({ state: first.state, code: 'code' })).rejects.toThrow('oauth_callback_mismatch')
    f.clock.date = new Date(f.clock.date.getTime() + 11 * 60_000)
    await expect(f.oauth.complete({ state: first.state, code: 'code', iss: issuer })).rejects.toThrow(
      'oauth_state_invalid',
    )
    expect(f.changes.exchangeCount).toBe(0)
  })

  it('a new authorization attempt invalidates the old state, including an exchange already in flight', async () => {
    const f = await fixture()
    const first = await f.start()
    f.changes.beforeToken = async () => {
      f.changes.beforeToken = undefined
      await f.start()
    }
    await expect(f.oauth.complete({ state: first.state, code: 'code', iss: issuer })).rejects.toThrow(
      'oauth_authorization_failed',
    )
    expect(
      (await f.service.openConnection(await f.service.getConnection(f.ownerId, f.connectionId))).config.authentication
        .type,
    ).toBe('none')
    const [pending] = await testDb.db
      .select()
      .from(cloudConnectionOAuth)
      .where(eq(cloudConnectionOAuth.connectionId, f.connectionId))
    expect(pending?.status).toBe('pending')
  })

  it('does not overwrite a connection saved or disabled during authorization', async () => {
    const f = await fixture()
    const started = await f.start()
    f.changes.beforeToken = async () => {
      await testDb.db
        .update(cloudConnections)
        .set({ version: 2, enabled: false })
        .where(eq(cloudConnections.id, f.connectionId))
    }
    await expect(f.oauth.complete({ state: started.state, code: 'code', iss: issuer })).rejects.toThrow(
      'oauth_authorization_failed',
    )
    const row = await f.service.getConnection(f.ownerId, f.connectionId)
    expect(row.enabled).toBe(false)
    expect((await f.service.openConnection(row)).config.authentication.type).toBe('none')
  })

  it('rejects discovery without required PKCE and issuer identity', async () => {
    const f = await fixture()
    f.changes.metadata = { ...metadata, code_challenge_methods_supported: ['plain'] }
    await expect(f.start()).rejects.toThrow('oauth_pkce_required')
    f.changes.metadata = { ...metadata, issuer: 'https://other.example.test' }
    await expect(f.start()).rejects.toThrow()
    expect(f.calls.filter((call) => call.path === '/register')).toHaveLength(0)
  })
})

describe('cloud OAuth refresh ownership', () => {
  it('serializes concurrent refreshes and increments only the credential version', async () => {
    const f = await fixture()
    await f.authorize()
    const original = await f.service.getConnection(f.ownerId, f.connectionId)
    f.clock.date = new Date(f.clock.date.getTime() + 3_601_000)
    const rows = await Promise.all([
      f.oauth.refresh(f.ownerId, f.connectionId),
      f.oauth.refresh(f.ownerId, f.connectionId),
    ])
    expect(f.changes.refreshCount).toBe(1)
    expect(rows[0]?.credentialVersion).toBe(original.credentialVersion + 1)
    expect(rows[1]?.credentialVersion).toBe(original.credentialVersion + 1)
    expect(rows[0]?.version).toBe(original.version)
    expect((await f.service.openConnection(rows[0]!)).config.authentication).toMatchObject({
      accessToken: 'cloud-access-1-1',
      refreshToken: 'cloud-refresh-1',
    })
    const refresh = f.calls.filter((call) => call.path === '/token').at(-1)!
    expect(new URLSearchParams(refresh.body).get('resource')).toBe(resource)
    expect(refresh.host).toBe('issuer.example.test')
  })

  it('commits needs-authorization after refresh failure and never blindly retries a consumed token', async () => {
    const f = await fixture()
    await f.authorize()
    f.clock.date = new Date(f.clock.date.getTime() + 3_601_000)
    f.changes.failTokens = true
    await expect(f.oauth.refresh(f.ownerId, f.connectionId)).rejects.toThrow('connection_needs_authorization')
    expect((await f.service.getConnection(f.ownerId, f.connectionId)).status).toBe('needs-authorization')
    await expect(f.oauth.refresh(f.ownerId, f.connectionId)).rejects.toThrow('connection_needs_authorization')
    expect(f.changes.refreshCount).toBe(1)
  })
})

describe('cloud OAuth network boundary', () => {
  it('blocks private destinations and refuses redirects before tokens can follow them', async () => {
    const f = await fixture()
    const blocked = createCloudOAuthFetch({
      ...f.network,
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    })
    await expect(blocked(`${issuer}/token`, { method: 'POST', body: 'refresh_token=secret' })).rejects.toThrow(
      'private/internal',
    )
    expect(f.calls).toHaveLength(0)
    const calls: string[] = []
    const redirecting = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input))
        return new Response(null, { status: 307, headers: { location: 'https://other.example.test/token' } })
      },
      { preconnect: () => {} },
    )
    const guarded = createCloudOAuthFetch({ ...f.network, fetchFn: redirecting })
    await expect(guarded(`${issuer}/token`, { method: 'POST', body: 'refresh_token=secret' })).rejects.toThrow(
      'oauth_redirect_refused',
    )
    expect(calls).toHaveLength(1)
  })
})

/** Exercise browser entry points with real session/device binding and the production version gate. */
const routeFixture = async (bound = true) => {
  const f = await fixture()
  const deviceId = crypto.randomUUID()
  const token = crypto.randomUUID()
  await testDb.db.insert(devicesTable).values({ id: deviceId, userId: f.ownerId, trusted: true, deviceType: 'normal' })
  await testDb.db.insert(session).values({
    id: crypto.randomUUID(),
    token,
    userId: f.ownerId,
    deviceId: bound ? deviceId : null,
    expiresAt: new Date(Date.now() + 3600_000),
    updatedAt: new Date(),
  })
  const app = new Elysia()
    .use(createAppVersionMiddleware({ minAppVersion: '1.0.0' }))
    .group('/v1', (routes) => routes.use(createCloudOAuthRoutes(createAuth(testDb.db), f.service, f.network)))
  const headers = { authorization: `Bearer ${signTestToken(token)}`, 'x-device-id': deviceId, 'x-app-version': '1.0.0' }
  const start = (override: Record<string, string> = {}) =>
    app.handle(
      new Request(`http://localhost/v1/cloud-agents/connections/${f.connectionId}/oauth/start`, {
        method: 'POST',
        headers: { ...headers, ...override },
      }),
    )
  return { ...f, app, headers, startRoute: start }
}

describe('cloud OAuth browser routes', () => {
  it('requires a signed-in session bound to the initiating trusted device before discovery', async () => {
    const f = await routeFixture()
    expect((await f.startRoute({ authorization: '' })).status).toBe(401)
    expect((await f.startRoute({ 'x-device-id': crypto.randomUUID() })).status).toBe(403)
    expect(f.calls).toHaveLength(0)
    const unbound = await routeFixture(false)
    expect((await unbound.startRoute()).status).toBe(403)
    expect(unbound.calls).toHaveLength(0)
    expect((await f.startRoute()).status).toBe(200)
  })

  it('accepts a headerless callback once, then redirects only to the configured application without secrets', async () => {
    const f = await routeFixture()
    const started = (await (await f.startRoute()).json()) as { authorizationUrl: string }
    const state = new URL(started.authorizationUrl).searchParams.get('state')!
    const url = new URL('http://localhost/v1/cloud-agents/oauth/callback')
    url.search = new URLSearchParams({ state, code: 'private-code', iss: issuer }).toString()
    const response = await f.app.handle(new Request(url))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://app.example.test/settings/cloud-agents?cloudOAuth=connected')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(f.changes.exchangeCount).toBe(1)
    const replay = await f.app.handle(new Request(url))
    expect(replay.status).toBe(303)
    expect(replay.headers.get('location')).toBe('https://app.example.test/settings/cloud-agents?cloudOAuth=failed')
    expect(f.changes.exchangeCount).toBe(1)
  })

  it('rejects duplicate callback parameters and never follows user-supplied return locations', async () => {
    const f = await routeFixture()
    const duplicated = await f.app.handle(
      new Request('http://localhost/v1/cloud-agents/oauth/callback?state=first&state=second'),
    )
    expect(duplicated.status).toBe(400)
    expect(f.calls).toHaveLength(0)
    const response = await f.app.handle(
      new Request('http://localhost/v1/cloud-agents/oauth/callback?state=invalid&redirect_uri=https://attacker.test'),
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://app.example.test/settings/cloud-agents?cloudOAuth=failed')
    expect(f.calls).toHaveLength(0)
  })
})
