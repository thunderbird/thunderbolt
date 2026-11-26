/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useConfigStore } from '@/api/config-store'
import { getAuthToken, setAuthToken, clearAuthToken } from '@/lib/auth-token'
import { createClient, createAuthenticatedClient } from '@/lib/http'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import {
  canChangeServer,
  connectToServer,
  disconnectUnclaimedServer,
  normalizeServerUrl,
  ServerVersionUnsupportedError,
} from './server-connection'
import { clearCachedSession, setCachedSession } from '@/lib/session-cache'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatThreadsTable } from '@/db/tables'

const settings = useLocalSettingsStore.getState()
const configState = useConfigStore.getState()

beforeEach(() => {
  useLocalSettingsStore.setState({ cloudUrl: '', syncEnabled: false, localMode: true, serverHasAuthenticated: false })
  useConfigStore.setState({ config: {}, configLoaded: false })
  clearCachedSession()
  clearAuthToken()
})
afterEach(() => {
  useLocalSettingsStore.setState(settings)
  useConfigStore.setState(configState)
  clearAuthToken()
  clearCachedSession()
})

describe('server selection', () => {
  it.each([
    [' https://example.com/ ', 'https://example.com/v1'],
    ['http://localhost:8000/v1/', 'http://localhost:8000/v1'],
    ['https://example.com/thunderbolt', 'https://example.com/thunderbolt/v1'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected)
  })

  it.each([
    '',
    'example.com',
    'file:///tmp/server',
    'https://user:secret@example.com',
    'https://example.com?q=key',
    'https://example.com/#fragment',
  ])('rejects invalid server input %s', (input) => {
    expect(() => normalizeServerUrl(input)).toThrow()
  })

  it('commits a validated server without enabling sync or retaining an old session', async () => {
    setAuthToken('stale-session')
    const fetch = mock(async () => Response.json({ builtInAgentEnabled: true, passkeyEnabled: false }))
    await connectToServer('https://example.com', createClient({ prefixUrl: 'https://example.com/v1', fetch }))
    expect(useLocalSettingsStore.getState()).toMatchObject({
      cloudUrl: 'https://example.com/v1',
      localMode: true,
      syncEnabled: false,
    })
    expect(useConfigStore.getState().config).toEqual({ builtInAgentEnabled: true, passkeyEnabled: false })
    expect(getAuthToken()).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([{}, [], null, { builtInAgentEnabled: 'true' }].map((body) => [body]))(
    'does not select a non-Thunderbolt response',
    async (body) => {
      const client = createClient({ prefixUrl: 'https://example.com/v1', fetch: async () => Response.json(body) })
      await expect(connectToServer('https://example.com', client)).rejects.toThrow('Thunderbolt server configuration')
      expect(useLocalSettingsStore.getState().cloudUrl).toBe('')
    },
  )

  it('leaves local state intact after a network failure', async () => {
    const client = createClient({
      prefixUrl: 'https://example.com/v1',
      fetch: async () => {
        throw new Error('offline')
      },
    })
    await expect(connectToServer('https://example.com', client)).rejects.toThrow('offline')
    expect(useLocalSettingsStore.getState().cloudUrl).toBe('')
    expect(useConfigStore.getState().config).toEqual({})
  })

  it('does not select a server after its connection flow is cancelled', async () => {
    const controller = new AbortController()
    const client = createClient({
      prefixUrl: 'https://example.com/v1',
      fetch: async () => {
        controller.abort()
        return Response.json({ builtInAgentEnabled: true })
      },
    })
    await expect(connectToServer('https://example.com', client, controller.signal)).rejects.toHaveProperty(
      'name',
      'AbortError',
    )
    expect(useLocalSettingsStore.getState().cloudUrl).toBe('')
    expect(useConfigStore.getState().config).toEqual({})
  })

  it('does not start a request for an already cancelled server connection', async () => {
    const fetch = mock(async () => Response.json({ builtInAgentEnabled: true }))
    const controller = new AbortController()
    controller.abort()
    await expect(
      connectToServer('https://example.com', createClient({ fetch }), controller.signal),
    ).rejects.toHaveProperty('name', 'AbortError')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses to switch an existing server into another account/data namespace', async () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://first.example/v1', serverHasAuthenticated: true })
    const fetch = mock(async () => Response.json({ builtInAgentEnabled: true }))
    await expect(connectToServer('https://second.example', createClient({ fetch }))).rejects.toThrow('Disconnect')
    expect(fetch).not.toHaveBeenCalled()
    expect(useLocalSettingsStore.getState().cloudUrl).toBe('https://first.example/v1')
  })

  it('rejects a server requiring a newer app before applying its configuration', async () => {
    const env = import.meta.env as Record<string, string | undefined>
    const previousVersion = env.VITE_APP_VERSION
    env.VITE_APP_VERSION = '1.0.0'
    try {
      const client = createClient({
        prefixUrl: 'https://example.com/v1',
        fetch: async () =>
          Response.json({
            builtInAgentEnabled: true,
            minAppVersion: '2.0.0',
          }),
      })
      await expect(connectToServer('https://example.com', client)).rejects.toBeInstanceOf(ServerVersionUnsupportedError)
      expect(useLocalSettingsStore.getState().cloudUrl).toBe('')
      expect(useConfigStore.getState().config).toEqual({})
    } finally {
      if (previousVersion === undefined) {
        delete env.VITE_APP_VERSION
      } else {
        env.VITE_APP_VERSION = previousVersion
      }
    }
  })
})

describe('correcting an unused server', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  it('clears only the selected server and preserves local chats and settings', async () => {
    await getDb().insert(chatThreadsTable).values({ id: 'local-before-server', title: 'My local conversation' })
    useLocalSettingsStore.setState({ cloudUrl: 'https://wrong.example/v1', theme: 'dark' })
    useConfigStore.setState({ config: { authMode: 'oidc' } })

    disconnectUnclaimedServer()

    expect(useLocalSettingsStore.getState()).toMatchObject({ cloudUrl: '', localMode: true, theme: 'dark' })
    expect(useConfigStore.getState().config).toEqual({})
    expect(await getDb().select().from(chatThreadsTable)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'local-before-server', title: 'My local conversation' })]),
    )
  })

  it('can select a different server before any account signs in', async () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://wrong.example/v1' })
    disconnectUnclaimedServer()
    await connectToServer(
      'https://correct.example',
      createClient({
        prefixUrl: 'https://correct.example/v1',
        fetch: async () => Response.json({ builtInAgentEnabled: true }),
      }),
    )
    expect(useLocalSettingsStore.getState().cloudUrl).toBe('https://correct.example/v1')
  })

  it('requires forgetting an unused server before selecting another', async () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://wrong.example/v1' })
    await expect(connectToServer('https://different.example')).rejects.toThrow('Disconnect')
    expect(useLocalSettingsStore.getState().cloudUrl).toBe('https://wrong.example/v1')
  })

  it('refuses to forget account data even after its session expires and sync is off', () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://account.example/v1', serverHasAuthenticated: true })
    expect(canChangeServer()).toBe(false)
    expect(disconnectUnclaimedServer).toThrow('account data')
    expect(useLocalSettingsStore.getState().cloudUrl).toBe('https://account.example/v1')
  })

  it('refuses a pending authenticated session even before its persistence listener marks the server', () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://account.example/v1' })
    setCachedSession({ user: { id: 'signed-in' }, session: { expiresAt: new Date(Date.now() + 60000) } })
    expect(disconnectUnclaimedServer).toThrow('account data')
  })
})

describe('standalone HTTP client', () => {
  it('refuses relative backend requests without making a network call', async () => {
    const fetch = mock(async () => Response.json({}))
    const client = createAuthenticatedClient('', () => 'secret', { fetch })
    await expect(client.get('config').json()).rejects.toThrow('Connect to a Thunderbolt server')
    await expect(client.post('sync', { json: {} })).rejects.toThrow('Connect to a Thunderbolt server')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('supports external APIs without attaching a Thunderbolt token or device headers', async () => {
    const requests: Request[] = []
    const client = createAuthenticatedClient('', () => 'secret', {
      fetch: async (input) => {
        requests.push(input as Request)
        return Response.json({ ok: true })
      },
    })
    expect(await client.get('https://example.com/api').json<{ ok: boolean }>()).toEqual({ ok: true })
    expect(requests[0].headers.has('Authorization')).toBe(false)
    expect(requests[0].headers.has('X-Device-ID')).toBe(false)
  })
})
