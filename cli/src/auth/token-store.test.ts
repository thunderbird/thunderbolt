/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childProcessBarrierModuleUrl, spawnBarrierChild } from '../lib/child-process-test-barrier.ts'
import type { CliAuth } from '../provider-runtime/types.ts'
import { defaultCloudUrl } from './config.ts'
import {
  clearAuthConfig as clearStoredAuth,
  compareAndSetAuthConfig as compareAndSetStoredAuth,
  loadAuthConfig as loadStoredAuth,
  resolveAccountCredential,
  resolveBridgeCredential,
  storeAuthConfig as storeStoredAuth,
  type AuthStateExpectation,
} from './token-store.ts'

let home: string
const tokenStoreModuleUrl = new URL('./token-store.ts', import.meta.url).href

/** Resolves the isolated auth path used by the current test. */
const authPath = (): string => join(home, 'auth.json')
const environment = (overrides: Readonly<Record<string, string | undefined>> = {}) => ({
  THUNDERBOLT_HOME: home,
  ...overrides,
})
const loadAuthConfig = () => loadStoredAuth(authPath())
const storeAuthConfig = (auth: CliAuth) => storeStoredAuth(auth, authPath())
const clearAuthConfig = () => clearStoredAuth(authPath())
const compareAndSetAuthConfig = (expected: AuthStateExpectation, next: CliAuth | null) =>
  compareAndSetStoredAuth(expected, next, authPath())

/** Starts one independent auth writer waiting to compare-and-set the same predecessor. */
const spawnAuthWriter = (path: string, expected: CliAuth, next: CliAuth) =>
  spawnBarrierChild(
    `
      import { waitForParentRelease } from ${JSON.stringify(childProcessBarrierModuleUrl)}
      import { compareAndSetAuthConfig } from ${JSON.stringify(tokenStoreModuleUrl)}
      const [path, expectedJson, nextJson] = process.argv.slice(1)
      await waitForParentRelease()
      try {
        console.log(await compareAndSetAuthConfig(
          { kind: 'exact', auth: JSON.parse(expectedJson) },
          JSON.parse(nextJson),
          path,
        ))
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error))
      }
    `,
    [path, JSON.stringify(expected), JSON.stringify(next)],
  )

/** Creates a representative valid registered auth installation. */
const createAuth = (): Extract<CliAuth, { bearer: string }> => ({
  version: 2,
  backendUrl: 'https://api.test/v1',
  deviceId: 'cli-00000000-0000-4000-8000-000000000001',
  userCacheSecret: 'ab'.repeat(32),
  registration: 'registered',
  bearer: 'signed.jwt',
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tb-auth-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('token store v2', () => {
  it('returns null before any login', async () => {
    expect(await loadAuthConfig()).toBeNull()
  })

  it('round-trips the strict versioned installation', async () => {
    const auth = createAuth()

    await storeAuthConfig(auth)

    expect(await loadAuthConfig()).toEqual(auth)
  })

  it('clears a regular stored installation', async () => {
    await storeAuthConfig(createAuth())

    await clearAuthConfig()

    expect(await loadAuthConfig()).toBeNull()
  })

  it('exact conditional demotion preserves a newer bearer on the same installation', async () => {
    const rejected = createAuth()
    const renewed = { ...rejected, bearer: 'renewed.jwt' }
    await storeAuthConfig(renewed)

    const changed = await compareAndSetAuthConfig(
      { kind: 'exact', auth: rejected },
      { ...rejected, registration: 'authentication-required', bearer: null },
    )

    expect(changed).toBeFalse()
    expect(await loadAuthConfig()).toEqual(renewed)
  })

  it('installation conditional clear removes a rebound bearer but preserves a rotated installation', async () => {
    const revoked = createAuth()
    const rebound = { ...revoked, bearer: 'rebound.jwt' }
    await storeAuthConfig(rebound)

    expect(await compareAndSetAuthConfig({ kind: 'installation', auth: revoked }, null)).toBeTrue()
    expect(await loadAuthConfig()).toBeNull()

    const rotated = {
      ...rebound,
      deviceId: 'cli-00000000-0000-4000-8000-000000000002' as const,
      userCacheSecret: 'cd'.repeat(32),
    }
    await storeAuthConfig(rotated)
    expect(await compareAndSetAuthConfig({ kind: 'installation', auth: revoked }, null)).toBeFalse()
    expect(await loadAuthConfig()).toEqual(rotated)
  })

  it('serializes concurrent conditional writes', async () => {
    const pending: CliAuth = { ...createAuth(), registration: 'authentication-required', bearer: null }
    const registeredA = { ...createAuth(), bearer: 'session-a' }
    const registeredB = { ...createAuth(), bearer: 'session-b' }
    await storeAuthConfig(pending)

    const results = await Promise.all([
      compareAndSetAuthConfig({ kind: 'exact', auth: pending }, registeredA),
      compareAndSetAuthConfig({ kind: 'exact', auth: pending }, registeredB),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
    const durable = await loadAuthConfig()
    if (durable === null) throw new Error('one conditional write must persist')
    expect([registeredA, registeredB].map((candidate) => JSON.stringify(candidate))).toContain(JSON.stringify(durable))
  })

  it('allows only one cross-process compare-and-set writer to match the predecessor', async () => {
    const pending: CliAuth = { ...createAuth(), registration: 'authentication-required', bearer: null }
    await storeAuthConfig(pending)
    const writers = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        spawnAuthWriter(authPath(), pending, {
          ...createAuth(),
          bearer: `session-${index}`,
        }),
      ),
    )
    writers.forEach((writer) => writer.release())

    const outputs = await Promise.all(writers.map((writer) => writer.result()))
    expect(outputs.sort()).toEqual(['false', 'false', 'false', 'false', 'false', 'false', 'false', 'true'])
  })

  it('rejects a symlink target on clear without changing its destination', async () => {
    const destination = join(home, 'destination')
    await writeFile(destination, 'original')
    await symlink(destination, authPath())

    await expect(clearAuthConfig()).rejects.toThrow('symlink')

    expect(await readFile(destination, 'utf8')).toBe('original')
    expect((await lstat(authPath())).isSymbolicLink()).toBe(true)
  })

  it('rejects invalid stored auth', async () => {
    await writeFile(authPath(), JSON.stringify({ ...createAuth(), userCacheSecret: 'TOO-SHORT' }))

    await expect(loadAuthConfig()).rejects.toMatchObject({ code: 'config-invalid' })
  })
})

describe('legacy auth migration', () => {
  it('migrates bearer and backend into a stable installation identity', async () => {
    await writeFile(authPath(), JSON.stringify({ token: 'legacy.jwt', cloudUrl: 'https://legacy.test/v1' }))

    const migrated = await loadAuthConfig()

    expect(migrated).toMatchObject({
      version: 2,
      backendUrl: 'https://legacy.test/v1',
      registration: 'legacy',
      bearer: 'legacy.jwt',
    })
    expect(migrated?.deviceId).toMatch(/^cli-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(migrated?.userCacheSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(await loadAuthConfig()).toEqual(migrated)
    expect(JSON.parse(await readFile(authPath(), 'utf8'))).toEqual(migrated)
  })

  it('singleflights concurrent legacy migration and returns the one durable installation', async () => {
    await writeFile(authPath(), JSON.stringify({ token: 'legacy.jwt', cloudUrl: 'https://legacy.test/v1' }))

    const migrated = await Promise.all(Array.from({ length: 50 }, () => loadAuthConfig()))
    const durable = await loadAuthConfig()

    expect(durable).not.toBeNull()
    expect(migrated.every((candidate) => JSON.stringify(candidate) === JSON.stringify(durable))).toBeTrue()
  })
})

describe('resolveAccountCredential', () => {
  it('resolves a stored session and decodes its cache secret', async () => {
    const byteValues = Array.from({ length: 32 }, (_, index) => index)
    const userCacheSecret = byteValues.map((value) => value.toString(16).padStart(2, '0')).join('')
    await storeAuthConfig({ ...createAuth(), userCacheSecret })

    const credential = await resolveAccountCredential(environment())

    expect(credential).toMatchObject({
      type: 'session',
      backendUrl: 'https://api.test/v1',
      bearer: 'signed.jwt',
      deviceId: 'cli-00000000-0000-4000-8000-000000000001',
    })
    expect(credential?.type).toBe('session')
    if (credential?.type !== 'session') throw new Error('expected a session credential')
    expect(Array.from(credential.userCacheSecret)).toEqual(byteValues)
  })

  it('returns null for an installation that requires authentication', async () => {
    await storeAuthConfig({
      ...createAuth(),
      registration: 'authentication-required',
      bearer: null,
    })

    expect(await resolveAccountCredential(environment())).toBeNull()
  })

  it('uses a PAT first without reading or falling back to invalid stored state', async () => {
    await writeFile(authPath(), '{invalid-stored-auth')

    expect(
      await resolveAccountCredential(
        environment({
          THUNDERBOLT_TOKEN: 'pat-xyz',
          THUNDERBOLT_CLOUD_URL: 'https://ci.example/v1',
        }),
      ),
    ).toEqual({ type: 'pat', backendUrl: 'https://ci.example/v1', token: 'pat-xyz' })
  })

  it('resolves a PAT against the default backend URL when the override is absent', async () => {
    expect(await resolveAccountCredential(environment({ THUNDERBOLT_TOKEN: 'pat-xyz' }))).toEqual({
      type: 'pat',
      backendUrl: defaultCloudUrl,
      token: 'pat-xyz',
    })
  })
})

describe('resolveBridgeCredential compatibility projection', () => {
  it('preserves PAT-first api-key projection over a stored session', async () => {
    await storeAuthConfig(createAuth())

    expect(
      await resolveBridgeCredential(
        environment({ THUNDERBOLT_TOKEN: 'pat-xyz', THUNDERBOLT_CLOUD_URL: 'https://ci.example/v1' }),
      ),
    ).toEqual({
      token: 'pat-xyz',
      cloudUrl: 'https://ci.example/v1',
      kind: 'apiKey',
    })
  })

  it('projects stored session metadata without device or cache fields', async () => {
    await storeAuthConfig(createAuth())

    expect(await resolveBridgeCredential(environment())).toEqual({
      token: 'signed.jwt',
      cloudUrl: 'https://api.test/v1',
      kind: 'session',
    })
  })

  it('returns null when no effective credential exists', async () => {
    expect(await resolveBridgeCredential(environment())).toBeNull()
  })
})
