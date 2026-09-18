/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { AccountFetch, CliAuth, DeviceGrantPresentation } from '../provider-runtime/types.ts'
import { cliVersion } from '../version.ts'
import { performLogout, type LogoutDeps } from './logout.ts'

const auth = (): Extract<CliAuth, { bearer: string }> => ({
  version: 2,
  backendUrl: 'https://api.test/v1',
  deviceId: 'cli-00000000-0000-4000-8000-000000000001',
  userCacheSecret: 'ab'.repeat(32),
  registration: 'registered',
  bearer: 'signed.jwt',
})

/** Records presentation callbacks without coupling lifecycle behavior to console I/O. */
const createPresentation = () => {
  const statuses: { readonly status: 'waiting' | 'success' | 'error'; readonly message?: string }[] = []
  const presentation: DeviceGrantPresentation = {
    showVerification: () => {},
    showStatus: (status, message) => {
      if (message === undefined) {
        statuses.push({ status })
        return
      }
      statuses.push({ status, message })
    },
  }
  return { presentation, statuses }
}

/** Builds logout dependencies and records all local persistence transitions. */
const createDeps = (fetchFn: AccountFetch, overrides: Partial<LogoutDeps> = {}) => {
  const events: string[] = []
  const stored: CliAuth[] = []
  const { presentation, statuses } = createPresentation()
  const deps: LogoutDeps = {
    auth: auth(),
    fetchFn: async (input, init) => {
      events.push('remote')
      return fetchFn(input, init)
    },
    loadAuth: async () => {
      events.push('load')
      return auth()
    },
    compareAndSetAuth: async (_expected, next) => {
      if (next === null) {
        events.push('clear')
        return true
      }
      events.push('store')
      stored.push(next)
      return true
    },
    presentation,
    ...overrides,
  }
  return { deps, events, presentation, statuses, stored }
}

describe('performLogout', () => {
  it('remotely revokes first, then clears the entire installation on exact 204', async () => {
    const requests: { readonly input: Parameters<AccountFetch>[0]; readonly init?: RequestInit }[] = []
    const { deps, events, statuses, stored } = createDeps(
      async (input, init) => {
        requests.push({ input, init })
        return new Response(null, { status: 204 })
      },
      { patToken: 'pat-remains-effective' },
    )

    const result = await performLogout(deps)

    expect(result).toBe('logged-out')
    expect(events).toEqual(['remote', 'clear'])
    expect(stored).toEqual([])
    expect(requests).toHaveLength(1)
    expect(String(requests[0]?.input)).toBe('https://api.test/v1/account/devices/cli/logout')
    expect(requests[0]?.init?.method).toBe('POST')
    expect(requests[0]?.init?.body).toBeUndefined()
    expect(requests[0]?.init?.redirect).toBe('error')
    expect(Object.fromEntries(new Headers(requests[0]?.init?.headers).entries())).toEqual({
      authorization: 'Bearer signed.jwt',
      'x-app-version': cliVersion,
    })
    expect(statuses.map(({ status }) => status)).toEqual(['waiting', 'success'])
  })

  it('reports confirmed remote logout plus local clear failure as actionable persistence failure', async () => {
    const diskFailure = new Error('auth directory is read-only')
    const { deps, events, statuses } = createDeps(async () => new Response(null, { status: 204 }), {
      compareAndSetAuth: async () => {
        events.push('clear')
        throw diskFailure
      },
    })

    await expect(performLogout(deps)).rejects.toMatchObject({
      code: 'persistence-failed',
      remoteLogoutConfirmed: true,
    })

    expect(events).toEqual(['remote', 'clear'])
    expect(statuses.map(({ status }) => status)).toEqual(['waiting', 'error'])
  })

  it('reports authentication changed when a newer login wins the post-204 compare-and-set', async () => {
    const newerAuth = {
      ...auth(),
      deviceId: 'cli-00000000-0000-4000-8000-000000000002' as const,
      bearer: 'newer-session',
    }
    const authReads = { count: 0 }
    const { deps, events, statuses } = createDeps(async () => new Response(null, { status: 204 }), {
      compareAndSetAuth: async () => {
        events.push('clear')
        return false
      },
      loadAuth: async () => {
        authReads.count += 1
        return newerAuth
      },
    })

    expect(await performLogout(deps)).toBe('authentication-changed')
    expect(authReads.count).toBe(1)
    expect(events).toEqual(['remote', 'clear'])
    expect(statuses.map(({ status }) => status)).toEqual(['waiting', 'error'])
    expect(statuses.at(-1)?.message).toContain('newer local session was retained')
  })

  it('reports authoritative 401 plus local bearer-clear failure as confirmed persistence failure', async () => {
    const { deps, events } = createDeps(async () => new Response(null, { status: 401 }), {
      compareAndSetAuth: async () => {
        events.push('store')
        throw new Error('auth directory is read-only')
      },
    })

    await expect(performLogout(deps)).rejects.toMatchObject({
      code: 'persistence-failed',
      remoteLogoutConfirmed: true,
      authenticationRequired: true,
    })
    expect(events).toEqual(['remote', 'store'])
  })

  it('clears only the bearer after an authoritative 401', async () => {
    const existing = auth()
    const { deps, events, statuses, stored } = createDeps(
      async () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
      { auth: existing },
    )

    const result = await performLogout(deps)

    expect(result).toBe('authentication-required')
    expect(events).toEqual(['remote', 'store'])
    expect(stored).toEqual([
      {
        ...existing,
        registration: 'authentication-required',
        bearer: null,
      },
    ])
    expect(statuses.map(({ status }) => status)).toEqual(['waiting', 'error'])
  })

  it('downgrades a legacy credential rejected because it has no server device binding', async () => {
    const existing: CliAuth = { ...auth(), registration: 'legacy' }
    const { deps, events, statuses, stored } = createDeps(
      async () => Response.json({ code: 'CLI_DEVICE_NOT_BOUND' }, { status: 409 }),
      { auth: existing },
    )

    expect(await performLogout(deps)).toBe('authentication-required')
    expect(events).toEqual(['remote', 'store'])
    expect(stored).toEqual([{ ...existing, registration: 'authentication-required', bearer: null }])
    expect(statuses.map(({ status }) => status)).toEqual(['waiting', 'error'])
  })

  it('treats a bodyless generic 401 as definitive session rejection', async () => {
    const existing = auth()
    const { deps, events, stored } = createDeps(async () => new Response(null, { status: 401 }), { auth: existing })

    expect(await performLogout(deps)).toBe('authentication-required')

    expect(events).toEqual(['remote', 'store'])
    expect(stored).toEqual([{ ...existing, registration: 'authentication-required', bearer: null }])
  })

  it('retains every byte when an unexpected success response is malformed', async () => {
    const { deps, events, stored } = createDeps(async () => new Response('not-json', { status: 200 }))

    await expect(performLogout(deps)).rejects.toBeInstanceOf(Error)

    expect(events).toEqual(['remote'])
    expect(stored).toEqual([])
  })

  it('does not persist or present success after an aborted logout request', async () => {
    const controller = new AbortController()
    const { deps, events, statuses } = createDeps(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
      { signal: controller.signal },
    )
    const pending = performLogout(deps)

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(events).toEqual(['remote'])
    expect(statuses.map(({ status }) => status)).toEqual(['waiting'])
  })

  it('reconciles an authoritative 204 even when cancellation races with the response', async () => {
    const controller = new AbortController()
    const { deps, events, statuses } = createDeps(
      async () => {
        controller.abort()
        return new Response(null, { status: 204 })
      },
      { signal: controller.signal },
    )

    await expect(performLogout(deps)).resolves.toBe('logged-out')
    expect(events).toEqual(['remote', 'clear'])
    expect(statuses.map(({ status }) => status)).toEqual(['waiting', 'success'])
  })

  it('reconciles an authoritative 401 even when cancellation races with the response', async () => {
    const controller = new AbortController()
    const { deps, events, stored } = createDeps(
      async () => {
        controller.abort()
        return new Response(null, { status: 401 })
      },
      { signal: controller.signal },
    )

    await expect(performLogout(deps)).resolves.toBe('authentication-required')
    expect(events).toEqual(['remote', 'store'])
    expect(stored[0]).toMatchObject({ registration: 'authentication-required', bearer: null })
  })

  it.each([
    ['network failure', async () => Promise.reject(new Error('offline'))],
    ['aborted request', async () => Promise.reject(new DOMException('aborted', 'AbortError'))],
    ['server failure', async () => Response.json({ error: 'Unavailable' }, { status: 503 })],
    ['unexpected success', async () => Response.json({ ok: true }, { status: 200 })],
  ] as const)('retains every byte after %s without retrying', async (_name, response) => {
    const calls = { count: 0 }
    const { deps, events, stored } = createDeps(async () => {
      calls.count += 1
      return response()
    })

    await expect(performLogout(deps)).rejects.toBeInstanceOf(Error)

    expect(calls.count).toBe(1)
    expect(events).toEqual(['remote'])
    expect(stored).toEqual([])
  })

  it('returns external management without HTTP for a PAT-only account', async () => {
    const calls = { count: 0 }
    const { deps, events, statuses, stored } = createDeps(
      async () => {
        calls.count += 1
        return new Response(null, { status: 204 })
      },
      { auth: null, patToken: 'pat-from-environment' },
    )

    const result = await performLogout(deps)

    expect(result).toBe('pat-managed-externally')
    expect(calls.count).toBe(0)
    expect(events).toEqual([])
    expect(stored).toEqual([])
    expect(statuses.map(({ status }) => status)).toEqual(['error'])
  })

  it('returns authentication-required without HTTP when no stored session exists', async () => {
    const calls = { count: 0 }
    const { deps, events } = createDeps(
      async () => {
        calls.count += 1
        return new Response(null, { status: 204 })
      },
      { auth: null },
    )

    expect(await performLogout(deps)).toBe('authentication-required')
    expect(calls.count).toBe(0)
    expect(events).toEqual([])
  })

  it('rejects an insecure remote origin before sending or mutating state', async () => {
    const calls = { count: 0 }
    const { deps, events, stored } = createDeps(
      async () => {
        calls.count += 1
        return new Response(null, { status: 204 })
      },
      { auth: { ...auth(), backendUrl: 'http://api.example.test/v1' } },
    )

    await expect(performLogout(deps)).rejects.toThrow('insecure')

    expect(calls.count).toBe(0)
    expect(events).toEqual([])
    expect(stored).toEqual([])
  })
})
