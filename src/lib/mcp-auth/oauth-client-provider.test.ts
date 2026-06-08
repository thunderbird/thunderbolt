/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import { getMcpServerCredentials } from '@/dal/mcp-secrets'
import { getDb } from '@/db/database'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createMcpOAuthClientProvider } from './oauth-client-provider'
import { setMcpOAuthState } from './mcp-oauth-state'

const origin = 'https://app.example.com'
const serverId = 'server-1'

const makeProvider = (isBackendConnected: boolean) =>
  createMcpOAuthClientProvider({
    serverId,
    db: getDb(),
    origin,
    isBackendConnected: () => isBackendConnected,
  })

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('McpOAuthClientProvider', () => {
  beforeEach(async () => {
    await resetTestDatabase()
    localStorage.clear()
  })

  describe('clientMetadata', () => {
    it('advertises a public client with the app-origin callback', () => {
      const metadata = makeProvider(true).clientMetadata
      expect(metadata.redirect_uris).toEqual([`${origin}/oauth/callback`])
      expect(metadata.token_endpoint_auth_method).toBe('none')
      expect(metadata.grant_types).toEqual(['authorization_code', 'refresh_token'])
      expect(metadata.response_types).toEqual(['code'])
    })
  })

  describe('clientMetadataUrl (CIMD disabled in PR 1 — DCR everywhere)', () => {
    it('returns undefined when backend-connected (CIMD not yet hosted)', () => {
      expect(makeProvider(true).clientMetadataUrl).toBeUndefined()
    })

    it('returns undefined in standalone (DCR fallback)', () => {
      expect(makeProvider(false).clientMetadataUrl).toBeUndefined()
    })
  })

  describe('tokens round-trip via mcp_secrets', () => {
    it('returns undefined when no oauth credentials exist', async () => {
      expect(await makeProvider(true).tokens()).toBeUndefined()
    })

    it('saveTokens then tokens preserves access/refresh/scope and reconstructs expires_in', async () => {
      const provider = makeProvider(true)
      await provider.saveTokens({
        access_token: 'access-1',
        token_type: 'Bearer',
        refresh_token: 'refresh-1',
        scope: 'read write',
        expires_in: 3600,
      })

      const stored = await getMcpServerCredentials(getDb(), serverId)
      expect(stored?.type).toBe('oauth')
      if (stored?.type !== 'oauth') {
        throw new Error('expected oauth credentials')
      }
      expect(stored.access_token).toBe('access-1')
      expect(stored.refresh_token).toBe('refresh-1')
      expect(stored.scope).toBe('read write')
      expect(stored.expires_at).toBeGreaterThan(Date.now())

      const tokens = await provider.tokens()
      expect(tokens?.access_token).toBe('access-1')
      expect(tokens?.refresh_token).toBe('refresh-1')
      expect(tokens?.scope).toBe('read write')
      // ~3600s reconstructed from the stored expires_at.
      expect(tokens?.expires_in).toBeGreaterThan(3500)
      expect(tokens?.expires_in).toBeLessThanOrEqual(3600)
    })

    it('preserves the prior refresh_token when a refresh omits one', async () => {
      const provider = makeProvider(true)
      await provider.saveTokens({ access_token: 'a1', token_type: 'Bearer', refresh_token: 'r1' })
      await provider.saveTokens({ access_token: 'a2', token_type: 'Bearer' })

      const stored = await getMcpServerCredentials(getDb(), serverId)
      if (stored?.type !== 'oauth') {
        throw new Error('expected oauth credentials')
      }
      expect(stored.access_token).toBe('a2')
      expect(stored.refresh_token).toBe('r1')
    })
  })

  describe('clientInformation persistence (DCR client_id, per-AS)', () => {
    it('returns undefined before registration', async () => {
      expect(await makeProvider(true).clientInformation()).toBeUndefined()
    })

    it('saveClientInformation persists the DCR client_id into the oauth blob', async () => {
      const provider = makeProvider(true)
      const full: OAuthClientInformationFull = {
        client_id: 'dcr-client-1',
        redirect_uris: [`${origin}/oauth/callback`],
      }
      await provider.saveClientInformation(full)

      const stored = await getMcpServerCredentials(getDb(), serverId)
      if (stored?.type !== 'oauth') {
        throw new Error('expected oauth credentials')
      }
      expect(stored.clientId).toBe('dcr-client-1')

      // A fresh provider (post-redirect) reads it back from the db.
      const reloaded = await makeProvider(true).clientInformation()
      expect(reloaded?.client_id).toBe('dcr-client-1')
    })

    it('does not discard existing tokens when persisting client info', async () => {
      const provider = makeProvider(true)
      await provider.saveTokens({ access_token: 'keep-me', token_type: 'Bearer', refresh_token: 'r1' })
      await provider.saveClientInformation({ client_id: 'dcr-2', redirect_uris: [`${origin}/oauth/callback`] })

      const stored = await getMcpServerCredentials(getDb(), serverId)
      if (stored?.type !== 'oauth') {
        throw new Error('expected oauth credentials')
      }
      expect(stored.access_token).toBe('keep-me')
      expect(stored.refresh_token).toBe('r1')
      expect(stored.clientId).toBe('dcr-2')
    })
  })

  describe('codeVerifier / state round-trip via the handshake', () => {
    it('saveCodeVerifier then codeVerifier round-trips', async () => {
      const provider = makeProvider(true)
      await provider.saveCodeVerifier('verifier-123')
      expect(await provider.codeVerifier()).toBe('verifier-123')
    })

    it('codeVerifier throws when none was saved', async () => {
      await expect(makeProvider(true).codeVerifier()).rejects.toThrow(/saveCodeVerifier/)
    })

    it('state reads the persisted CSRF nonce', async () => {
      setMcpOAuthState({ stateNonce: 'nonce-abc' })
      expect(await makeProvider(true).state()).toBe('nonce-abc')
    })

    it('state throws when no nonce is persisted', async () => {
      await expect(makeProvider(true).state()).rejects.toThrow(/nonce/)
    })
  })
})
