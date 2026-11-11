/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as adapterCache from '@/acp/adapter-cache'
import { getCachedImageSupport, setCachedImageSupport } from '@/ai/image-support'
import { setActiveLocale } from '@/i18n/active-locale'
import { exportUserData } from '@/dal/export'
import { getMcpServerCredentials, setMcpServerCredentials } from '@/dal/mcp-secrets'
import { getAllMcpServers } from '@/dal/mcp-servers'
import * as dal from '@/dal'
import { getSettings } from '@/dal'
import { applySchema } from '@/db/apply-schema'
import { Database } from '@/db/database'
import { agentsSecretsTable, integrationsSecretsTable, mcpServersTable, modelsSecretsTable } from '@/db/tables'
import * as encryption from '@/services/encryption'
import { defaultVoiceProvider, useLocalSettingsStore } from '@/stores/local-settings-store'
import { getAuthToken, getDeviceId, setAuthToken } from './auth-token'
import { getOAuthState, setOAuthState } from './oauth-state'
import { isRecoveryPhrasePending, markRecoveryPhrasePending } from './recovery-phrase-pending'
import {
  attachmentDatabaseName,
  bindLocalData,
  deferOnboardedMark,
  forgetLocalDataSlots,
  getLocalDataStatus,
  isLocalDataOwnedBy,
  openLocalData,
  releaseSignedOutLocalData,
  resetLocalDataOwnerForTests,
  subscribeLocalDataStatus,
} from './local-data-owner'
import * as platform from './platform'
import { applyDeferredOnboardedMark } from './returning-user-onboarding'
import { getClock } from '@/testing-library'
import { localDataKey, readLocalDataRecord as record } from '@/test-utils/local-data'
import { setCachedSession } from './session-cache'

const isReady = () => getLocalDataStatus() === 'ready'

// One directory per test: it stands for the browser profile's storage.
let dir: string
let previousLocalSettings: ReturnType<typeof useLocalSettingsStore.getState>
const open: Database[] = []

/** What a page load does: open the active slot's database file. */
const boot = async () => {
  for (const database of open.splice(0)) {
    await database.close()
  }
  resetLocalDataOwnerForTests()
  const filename = await openLocalData()
  const database = new Database()
  await database.initialize({ type: 'bun-sqlite', path: join(dir, filename) })
  await applySchema(database.db)
  open.push(database)
  return { db: database.db, filename }
}

let reload: ReturnType<typeof spyOn>

/** Resolves once a switch reloads the page or fails. */
const settled = () =>
  new Promise<void>((resolve) => {
    reload.mockImplementation(() => resolve())
    const unsubscribe = subscribeLocalDataStatus(() => {
      if (getLocalDataStatus() === 'failed') {
        unsubscribe()
        resolve()
      }
    })
  })

const voiceKey = (apiKey: string) => ({ ...defaultVoiceProvider, kind: 'openai-compatible' as const, apiKey })

/** Account settings as a switch stashes them on a slot, holding this voice key. */
const stashedSettings = (apiKey: string) => ({ voiceProvider: voiceKey(apiKey), recoveryPhrasePending: false })

/** A's local-only credentials: one row in each secret table, plus the device-local voice key. */
const storeSecrets = async (db: Awaited<ReturnType<typeof boot>>['db']) => {
  await db.insert(mcpServersTable).values({ id: 'mcp-a', name: 'A server', url: 'https://mcp.example' })
  await setMcpServerCredentials(db, 'mcp-a', { type: 'bearer', token: 'synthetic-a-token' })
  await db.insert(integrationsSecretsTable).values({ provider: 'google', credentials: '{"token":"a"}' })
  await db.insert(modelsSecretsTable).values({ modelId: 'model-a', apiKey: 'model-a-key' })
  await db.insert(agentsSecretsTable).values({ agentId: 'agent-a', apiKey: 'agent-a-key' })
  useLocalSettingsStore.getState().setLocalSetting('voiceProvider', voiceKey('voice-a-key'))
}

/** MCP rows as "Export My Data" sees them, plus the secret tables export leaves out. */
const secretRowCount = async (db: Awaited<ReturnType<typeof boot>>['db']) => {
  const { tables } = await exportUserData(db, { id: 'whoever', email: null })
  const unexported = await Promise.all(
    [integrationsSecretsTable, modelsSecretsTable, agentsSecretsTable].map((table) => db.select().from(table)),
  )
  return tables.mcp_servers.length + tables.mcp_secrets.length + unexported.flat().length
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-data-owner-'))
  previousLocalSettings = useLocalSettingsStore.getState()
  localStorage.clear()
  useLocalSettingsStore.setState({
    cloudUrl: 'https://api.test/v1',
    localMode: false,
    serverHasAuthenticated: true,
    voiceProvider: defaultVoiceProvider,
    recoveryPhrasePending: false,
  })
  spyOn(platform, 'isOpfsAvailable').mockResolvedValue(false)
  spyOn(platform, 'hasIndexedDbDatabase').mockResolvedValue(false)
  spyOn(adapterCache, 'disposeAllAdapters').mockResolvedValue()
  spyOn(encryption, 'handleFullWipe').mockResolvedValue()
  reload = spyOn(window.location, 'reload').mockImplementation(() => undefined)
})

afterEach(async () => {
  for (const database of open.splice(0)) {
    await database.close()
  }
  resetLocalDataOwnerForTests()
  mock.restore()
  localStorage.clear()
  useLocalSettingsStore.setState(previousLocalSettings)
  rmSync(dir, { recursive: true, force: true })
})

describe('local data owner', () => {
  it('lets the first account claim a fresh device', async () => {
    spyOn(platform, 'isOpfsAvailable').mockResolvedValue(true)
    spyOn(platform, 'hasOpfsFile').mockResolvedValue(false)
    const { filename } = await boot()
    expect(filename).toBe(platform.powerSyncDbFilename)
    // The default slot keeps the attachment store from before slots.
    expect(attachmentDatabaseName()).toBe('thunderbolt-files')
    expect(bindLocalData('user-a')).toBe(true)
    expect(isLocalDataOwnedBy('user-a')).toBe(true)
    expect(isLocalDataOwnedBy('user-b')).toBe(false)
  })

  it('treats a database opened without `openLocalData` as no account’s', () => {
    expect(isLocalDataOwnedBy('user-a')).toBe(false)
    expect(bindLocalData('user-a')).toBe(false)
    expect(getLocalDataStatus()).toBe('ready')
  })

  it('keeps A’s data for A after "Leave data on device"', async () => {
    const first = await boot()
    bindLocalData('user-a')
    await storeSecrets(first.db)

    // A logs out with "Leave data on device", which leaves the database alone; the page reloads and A signs back in.
    const again = await boot()
    expect(again.filename).toBe(first.filename)
    expect(bindLocalData('user-a')).toBe(true)
    expect(reload).not.toHaveBeenCalled()
    expect(await getMcpServerCredentials(again.db, 'mcp-a')).toEqual({ type: 'bearer', token: 'synthetic-a-token' })
    expect(await secretRowCount(again.db)).toBe(5)
    expect(useLocalSettingsStore.getState().voiceProvider.apiKey).toBe('voice-a-key')
  })

  it('gives B its own database and never A’s secrets, then gives A its data back', async () => {
    const a = await boot()
    bindLocalData('user-a')
    await storeSecrets(a.db)
    const deviceIdOfA = getDeviceId()

    // A logs out leaving data on the device, then B signs in on the same profile.
    await boot()
    setAuthToken('token-of-b')
    const switched = settled()
    expect(bindLocalData('user-b')).toBe(false)
    expect(isReady()).toBe(false)
    expect(isLocalDataOwnedBy('user-b')).toBe(false)
    await switched
    expect(reload).toHaveBeenCalledTimes(1)
    expect(encryption.handleFullWipe).toHaveBeenCalledTimes(1)
    expect(getAuthToken()).toBe('token-of-b')
    expect(getDeviceId()).not.toBe(deviceIdOfA)
    expect(useLocalSettingsStore.getState().voiceProvider).toEqual(defaultVoiceProvider)

    const b = await boot()
    expect(b.filename).not.toBe(a.filename)
    expect(bindLocalData('user-b')).toBe(true)
    expect(await getAllMcpServers(b.db)).toEqual([])
    expect(await getMcpServerCredentials(b.db, 'mcp-a')).toBeNull()
    expect(await secretRowCount(b.db)).toBe(0)
    useLocalSettingsStore.getState().setLocalSetting('voiceProvider', voiceKey('voice-b-key'))

    // B leaves data on device too; A signs back in.
    await boot()
    const back = settled()
    expect(bindLocalData('user-a')).toBe(false)
    await back
    const aAgain = await boot()
    expect(aAgain.filename).toBe(a.filename)
    expect(bindLocalData('user-a')).toBe(true)
    expect(await secretRowCount(aAgain.db)).toBe(5)
    expect(useLocalSettingsStore.getState().voiceProvider.apiKey).toBe('voice-a-key')
  })

  it('keeps A’s state outside the database away from B, and gives A its own back', async () => {
    const modelOfA = { provider: 'custom', url: 'https://llm.a.example/v1', model: 'model-a', vendor: null } as const
    /** Sign `userId` in on the open slot, which switches, then boot into `userId`'s slot. */
    const switchTo = async (userId: string) => {
      const switched = settled()
      expect(bindLocalData(userId)).toBe(false)
      await switched
      await boot()
      expect(bindLocalData(userId)).toBe(true)
    }
    await boot()
    bindLocalData('user-a')
    markRecoveryPhrasePending()
    const attachmentsOfA = attachmentDatabaseName()
    setCachedImageSupport(modelOfA, 'supported')
    setOAuthState({ state: 'state-of-a', provider: 'google', verifier: 'verifier-of-a' })
    setActiveLocale('de')

    // A leaves data on the device, then B signs in.
    await boot()
    await switchTo('user-b')
    expect(isRecoveryPhrasePending()).toBe(false)
    expect(attachmentDatabaseName()).not.toBe(attachmentsOfA)
    expect(getCachedImageSupport(modelOfA)).toBeUndefined()
    expect(getOAuthState().verifier).toBeNull()
    expect(localStorage.getItem('thunderbolt_locale')).toBeNull()

    // B leaves data on the device too, and A signs back in.
    await boot()
    await switchTo('user-a')
    expect(isRecoveryPhrasePending()).toBe(true)
    expect(attachmentDatabaseName()).toBe(attachmentsOfA)
  })

  describe('a new slot no one can prove they own', () => {
    // A set a voice key and left a recovery phrase unsaved, then signed out with "Leave data on
    // device", which keeps both live.
    beforeEach(() => {
      useLocalSettingsStore.setState({ voiceProvider: voiceKey('voice-a-key'), recoveryPhrasePending: true })
    })

    /** The page loads, then B's session binds and claims the open slot without a switch. */
    const bootAndSignInB = async () => {
      await boot()
      setAuthToken('token-of-b')
      expect(bindLocalData('user-b')).toBe(true)
      expect(useLocalSettingsStore.getState().voiceProvider).toEqual(defaultVoiceProvider)
      expect(isRecoveryPhrasePending()).toBe(false)
    }

    it('starts from default account settings after an upgrade, where A signed out before slots', async () => {
      spyOn(platform, 'isOpfsAvailable').mockResolvedValue(true)
      spyOn(platform, 'hasOpfsFile').mockResolvedValue(true)
      await bootAndSignInB()
    })

    it('starts from default account settings on the first boot with slots without OPFS', async () => {
      await bootAndSignInB()
    })

    it('starts from default account settings, and says why, when the record is unreadable', async () => {
      const error = spyOn(console, 'error').mockImplementation(() => {})
      localStorage.setItem(localDataKey, '{"slots":')
      await bootAndSignInB()
      expect(error).toHaveBeenCalledTimes(1)
    })

    it('starts from default account settings after a wipe, such as the error screen’s clear while signed out', async () => {
      await boot()
      bindLocalData('user-a')
      forgetLocalDataSlots()
      await bootAndSignInB()
    })
  })

  it('without OPFS, gives the new slot to the account signed in at upgrade, with its voice key', async () => {
    useLocalSettingsStore.getState().setLocalSetting('voiceProvider', voiceKey('voice-a-key'))
    setAuthToken('token-of-a')
    setCachedSession({ user: { id: 'user-a' }, session: { token: 'token-of-a' } })
    const { filename } = await boot()
    expect(filename).not.toBe(platform.powerSyncDbFilename)
    expect(bindLocalData('user-a')).toBe(true)
    expect(useLocalSettingsStore.getState().voiceProvider.apiKey).toBe('voice-a-key')
  })

  describe('a reload by the slot’s owner', () => {
    const env = import.meta.env as Record<string, string | undefined>
    const cacheSession = (userId: string) =>
      setCachedSession({
        user: { id: userId },
        session: { token: 'token-of-a', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      })

    beforeEach(async () => {
      await boot()
      bindLocalData('user-a')
      setAuthToken('token-of-a')
    })
    afterEach(() => {
      delete env.VITE_AUTH_MODE
    })

    it('binds the cached session at boot, before sync asks for credentials', async () => {
      cacheSession('user-a')
      await boot()
      expect(isLocalDataOwnedBy('user-a')).toBe(true)
    })

    it('leaves a cached session for another account to switch once the session resolves', async () => {
      cacheSession('user-b')
      await boot()
      expect(getLocalDataStatus()).toBe('unbound')
      expect(encryption.handleFullWipe).not.toHaveBeenCalled()
    })

    it('binds the cached session in SSO mode too, though the cookie may belong to someone else', async () => {
      env.VITE_AUTH_MODE = 'sso'
      cacheSession('user-a')
      await boot()
      expect(isLocalDataOwnedBy('user-a')).toBe(true)
    })
  })

  describe('a cookie-only session at upgrade (no bearer token)', () => {
    const env = import.meta.env as Record<string, string | undefined>
    beforeEach(() => {
      spyOn(platform, 'isOpfsAvailable').mockResolvedValue(true)
      spyOn(platform, 'hasOpfsFile').mockResolvedValue(true)
      setCachedSession({ user: { id: 'user-a' } })
    })
    afterEach(() => {
      delete env.VITE_AUTH_MODE
    })

    it('keeps the pre-slot database for the cached account in SSO mode, where the cookie is the session', async () => {
      env.VITE_AUTH_MODE = 'sso'
      expect((await boot()).filename).toBe(platform.powerSyncDbFilename)
      expect(record().slots.default).toEqual({
        owner: 'user-a',
      })
    })

    it('never trusts the cache alone outside SSO mode', async () => {
      expect((await boot()).filename).not.toBe(platform.powerSyncDbFilename)
    })
  })

  it('never opens a pre-slot database kept by a signed-out account', async () => {
    // An OPFS install whose database predates slots (here, still in IndexedDB).
    spyOn(platform, 'isOpfsAvailable').mockResolvedValue(true)
    spyOn(platform, 'hasOpfsFile').mockResolvedValue(false)
    spyOn(platform, 'hasIndexedDbDatabase').mockResolvedValue(true)
    const { filename } = await boot()
    expect(filename).not.toBe(platform.powerSyncDbFilename)
    expect(bindLocalData('user-b')).toBe(true)
    // A later boot still does not fall back to it.
    expect((await boot()).filename).toBe(filename)
  })

  it('keeps a pre-slot database for the account signed in when slots arrive', async () => {
    // An OPFS install whose database predates slots (here, still in IndexedDB).
    spyOn(platform, 'isOpfsAvailable').mockResolvedValue(true)
    spyOn(platform, 'hasOpfsFile').mockResolvedValue(false)
    spyOn(platform, 'hasIndexedDbDatabase').mockResolvedValue(true)
    setAuthToken('token-of-a')
    setCachedSession({ user: { id: 'user-a' }, session: { token: 'token-of-a' } })
    const { filename } = await boot()
    expect(filename).toBe(platform.powerSyncDbFilename)
    // A owns it, and nothing uses it until a session resolves.
    expect(record().slots.default.owner).toBe('user-a')
    expect(isReady()).toBe(false)
    const switched = settled()
    expect(bindLocalData('user-b')).toBe(false)
    await switched
  })

  it('keeps pre-slot standalone data and its settings for the first account', async () => {
    spyOn(platform, 'isOpfsAvailable').mockResolvedValue(true)
    spyOn(platform, 'hasOpfsFile').mockResolvedValue(true)
    const legacy = new Database()
    await legacy.initialize({ type: 'bun-sqlite', path: join(dir, platform.powerSyncDbFilename) })
    await applySchema(legacy.db)
    open.push(legacy)
    await storeSecrets(legacy.db)
    useLocalSettingsStore.setState({ cloudUrl: '', localMode: true, serverHasAuthenticated: false })

    const upgraded = await boot()

    expect(upgraded.filename).toBe(platform.powerSyncDbFilename)
    expect(await getMcpServerCredentials(upgraded.db, 'mcp-a')).toEqual({ type: 'bearer', token: 'synthetic-a-token' })
    expect(useLocalSettingsStore.getState().voiceProvider.apiKey).toBe('voice-a-key')
    expect(bindLocalData('first-account')).toBe(true)
    expect(await secretRowCount(upgraded.db)).toBe(5)
  })

  it.each([undefined, true])(
    'does not reclaim pre-slot data when prior authentication is %s',
    async (serverHasAuthenticated) => {
      spyOn(platform, 'isOpfsAvailable').mockResolvedValue(true)
      spyOn(platform, 'hasOpfsFile').mockResolvedValue(true)
      localStorage.setItem(
        'thunderbolt-local-settings',
        JSON.stringify({ state: { cloudUrl: '', localMode: true, serverHasAuthenticated }, version: 1 }),
      )

      const upgraded = await boot()

      expect(upgraded.filename).not.toBe(platform.powerSyncDbFilename)
      expect(await getMcpServerCredentials(upgraded.db, 'mcp-a')).toBeNull()
    },
  )

  it('lets only the upgraded session’s own token claim a pre-slot database without a cached user', async () => {
    // An OPFS install whose database predates slots (here, still in IndexedDB).
    spyOn(platform, 'isOpfsAvailable').mockResolvedValue(true)
    spyOn(platform, 'hasOpfsFile').mockResolvedValue(false)
    spyOn(platform, 'hasIndexedDbDatabase').mockResolvedValue(true)
    setAuthToken('token-of-a')
    await boot()
    // The ownership record outlives the token, so it must not hold a usable copy of it.
    expect(localStorage.getItem(localDataKey)).not.toContain('token-of-a')
    // The token was rejected and another account signed in at the sign-in prompt.
    setAuthToken('token-of-c')
    const switched = settled()
    expect(bindLocalData('user-c')).toBe(false)
    await switched

    resetLocalDataOwnerForTests()
    localStorage.clear()
    useLocalSettingsStore.setState({ cloudUrl: useLocalSettingsStore.getState().cloudUrl })
    setAuthToken('token-of-a')
    await boot()
    expect(bindLocalData('user-a')).toBe(true)
  })

  it('fails closed on an unreadable ownership record', async () => {
    spyOn(console, 'error').mockImplementation(() => {})
    await boot()
    bindLocalData('user-a')
    localStorage.setItem(localDataKey, '{"slots":')
    const { filename } = await boot()
    expect(filename).not.toBe(platform.powerSyncDbFilename)
  })

  it('keeps B blocked and A’s slot active when removing A’s keys fails', async () => {
    const a = await boot()
    bindLocalData('user-a')
    spyOn(encryption, 'handleFullWipe').mockRejectedValue(new Error('key store locked'))
    const failed = settled()
    expect(bindLocalData('user-b')).toBe(false)
    await failed
    expect(getLocalDataStatus()).toBe('failed')
    expect(reload).not.toHaveBeenCalled()
    expect(bindLocalData('user-b')).toBe(false)
    expect(isLocalDataOwnedBy('user-a')).toBe(false)

    // Reloading retries from A's slot rather than letting B in.
    expect((await boot()).filename).toBe(a.filename)
    expect(isLocalDataOwnedBy('user-b')).toBe(false)
  })

  it('leaves in place a full wipe another tab ran while it removed A’s keys', async () => {
    await boot()
    bindLocalData('user-a')
    spyOn(encryption, 'handleFullWipe').mockImplementation(async () => forgetLocalDataSlots())
    const switched = settled()
    expect(bindLocalData('user-b')).toBe(false)
    await switched
    // Only the wipe's ownerless slot is left; B's session claims it after the reload.
    const { active, slots } = record()
    expect(slots).toEqual({ [active]: {} })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('passes an anonymous account’s data to the account it is promoted into', async () => {
    await boot()
    bindLocalData('anon-1', { isAnonymous: true })
    expect(bindLocalData('user-a', { promotedFrom: 'anon-1' })).toBe(true)
    expect(isLocalDataOwnedBy('user-a')).toBe(true)
    expect(reload).not.toHaveBeenCalled()
    // A's slot now, so no boot may delete it as an anonymous one.
    expect(record().slots[record().active]).toEqual({ owner: 'user-a' })
  })

  it('does not pass a named account’s data through a promotion claim', async () => {
    await boot()
    bindLocalData('user-a')
    const switched = settled()
    expect(bindLocalData('user-b', { promotedFrom: 'anon-1' })).toBe(false)
    await switched
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('deletes an expired anonymous session’s slot once the next anonymous session is the one on the device', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const deleted = spyOn(platform, 'deleteIndexedDbDatabase').mockResolvedValue()
    const x = await boot()
    setAuthToken('token-of-x')
    bindLocalData('anon-x', { isAnonymous: true })
    // X's session expired: `/get-session` answers that nobody is signed in, and the auth gate signs in anonymous Y.
    await boot()
    releaseSignedOutLocalData()
    setAuthToken('token-of-y')
    const toY = settled()
    expect(bindLocalData('anon-y', { isAnonymous: true })).toBe(false)
    await toY
    setCachedSession({ user: { id: 'anon-y', isAnonymous: true }, session: { token: 'token-of-y', expiresAt } })
    await boot()
    expect(deleted).toHaveBeenCalledWith(x.filename)
    expect(Object.values<{ owner?: string }>(record().slots).map((slot) => slot.owner)).toEqual(['anon-y'])
  })

  describe('an anonymous slot whose account signed in to one with its own slot here', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const anonymousSlotRecorded = () =>
      Object.values<{ owner?: string }>(record().slots).some((slot) => slot.owner === 'anon-1')

    /** A signed out leaving data, the device took an anonymous session, and that session signed in to A. */
    const signInFromAnonymousSession = async () => {
      await boot()
      bindLocalData('user-a')
      await boot()
      setAuthToken('token-of-anon')
      const toAnonymous = settled()
      bindLocalData('anon-1', { isAnonymous: true })
      await toAnonymous
      const anonymous = await boot()
      bindLocalData('anon-1', { isAnonymous: true })
      const toA = settled()
      expect(bindLocalData('user-a', { promotedFrom: 'anon-1' })).toBe(false)
      await toA
      return anonymous.filename
    }

    it('is deleted at the next boot once the anonymous token is gone', async () => {
      const deleted = spyOn(platform, 'deleteIndexedDbDatabase').mockResolvedValue()
      const filename = await signInFromAnonymousSession()
      setAuthToken('token-of-a')
      setCachedSession({ user: { id: 'user-a' }, session: { token: 'token-of-a', expiresAt } })
      await boot()
      expect(deleted).toHaveBeenCalledWith(filename)
      // Its attachment store too.
      expect(deleted).toHaveBeenCalledWith(filename.replace('thunderbolt-sync-', 'thunderbolt-files-').slice(0, -3))
      expect(anonymousSlotRecorded()).toBe(false)
    })

    it('stays while the anonymous session is still the one on the device, which gets it back', async () => {
      const deleted = spyOn(platform, 'deleteIndexedDbDatabase').mockResolvedValue()
      const filename = await signInFromAnonymousSession()
      // The sign-in's token write was cancelled after the switch began, so the anonymous session survives.
      setCachedSession({ user: { id: 'anon-1' }, session: { token: 'token-of-anon', expiresAt } })
      await boot()
      expect(deleted).not.toHaveBeenCalled()
      const back = settled()
      expect(bindLocalData('anon-1', { isAnonymous: true })).toBe(false)
      await back
      expect((await boot()).filename).toBe(filename)
      expect(isLocalDataOwnedBy('anon-1')).toBe(true)

      // Its owner came back to it, so it is the active slot: a later boot without the token keeps it.
      localStorage.removeItem('thunderbolt_auth_token')
      await boot()
      expect(deleted).not.toHaveBeenCalled()
      expect(anonymousSlotRecorded()).toBe(true)
    })
  })

  it('applies a returning-user mark in the slot it was meant for', async () => {
    await boot()
    bindLocalData('user-a')
    const switched = settled()
    bindLocalData('user-b')
    deferOnboardedMark()
    await switched
    const b = await boot()
    await applyDeferredOnboardedMark(b.db)
    expect((await getSettings(b.db, { user_has_completed_onboarding: false })).userHasCompletedOnboarding).toBe(true)
  })

  it('keeps a returning-user mark until it is written, so a failed boot does not lose it', async () => {
    await boot()
    bindLocalData('user-a')
    const switched = settled()
    bindLocalData('user-b')
    deferOnboardedMark()
    await switched
    const failing = await boot()
    const write = spyOn(dal, 'updateSettings').mockRejectedValueOnce(new Error('disk full'))
    await expect(applyDeferredOnboardedMark(failing.db)).rejects.toThrow('disk full')
    write.mockRestore()

    // Reloading boots again.
    const b = await boot()
    await applyDeferredOnboardedMark(b.db)
    expect((await getSettings(b.db, { user_has_completed_onboarding: false })).userHasCompletedOnboarding).toBe(true)
  })

  it('without OPFS, keeps every slot under its own name and never reuses the default one', async () => {
    // A fresh profile, or one wiped while another tab may still hold the default name in memory.
    const first = await boot()
    expect(first.filename).toMatch(/^thunderbolt-sync-[0-9a-f-]{36}\.db$/)
    expect(await platform.getDatabasePath('app-data', first.filename)).toBe(first.filename)
    localStorage.clear()
    expect((await boot()).filename).not.toBe(first.filename)
  })

  it('keeps each voice key with its account wherever a switch dies, and the retry finishes', async () => {
    const liveKey = () => useLocalSettingsStore.getState().voiceProvider.apiKey
    const slotB = 'b0000000-0000-4000-8000-000000000000'
    await boot()
    bindLocalData('user-a')
    useLocalSettingsStore.getState().setLocalSetting('voiceProvider', voiceKey('voice-a-key'))
    const slotA = record().active
    localStorage.setItem(
      localDataKey,
      JSON.stringify({
        ...record(),
        slots: { ...record().slots, [slotB]: { owner: 'user-b', settings: stashedSettings('voice-b-key') } },
      }),
    )

    // Capture every state the switch persists. The ownership record and the voice key live in two keys,
    // and every write to either serializes first. So the storage seen at each serialization is the
    // state right after the previous write, which is exactly what a crash at that point leaves.
    const persisted = [localDataKey, 'thunderbolt-local-settings']
    const states = new Map<string, [string, string | null][]>()
    const capture = () => {
      const entries = persisted.map((name): [string, string | null] => [name, localStorage.getItem(name)])
      states.set(entries.map(([, value]) => value ?? '').join('\u0000'), entries)
    }
    const stringify = JSON.stringify
    const spy = spyOn(JSON, 'stringify').mockImplementation(((...args: Parameters<typeof JSON.stringify>) => {
      capture()
      return stringify(...args)
    }) as typeof JSON.stringify)
    const switched = settled()
    bindLocalData('user-b')
    await switched
    spy.mockRestore()
    capture()
    const snapshots = [...states.values()]
    expect(snapshots.length).toBeGreaterThanOrEqual(4)

    for (const snapshot of snapshots) {
      // The tab died right after this write, and the browser released its switch lock.
      for (const [name, value] of snapshot) {
        if (value === null) {
          localStorage.removeItem(name)
        } else {
          localStorage.setItem(name, value)
        }
      }
      await useLocalSettingsStore.persist.rehydrate()
      await boot()
      if (record().active === slotA) {
        // A's slot comes back with A's key live, and B's key is still B's.
        expect(liveKey()).toBe('voice-a-key')
        expect(record().slots[slotB].settings.voiceProvider.apiKey).toBe('voice-b-key')
        expect(record().slots[slotA].settings).toBeUndefined()
        expect(record().switchingTo).toBeUndefined()
        // B's session redoes the switch.
        const retried = settled()
        expect(bindLocalData('user-b')).toBe(false)
        await retried
        await boot()
      }
      expect(record().active).toBe(slotB)
      expect(record().switchingTo).toBeUndefined()
      expect(liveKey()).toBe('voice-b-key')
      expect(record().slots[slotA].settings.voiceProvider.apiKey).toBe('voice-a-key')
      expect(record().slots[slotB].settings).toBeUndefined()
    }
  })

  describe('other tabs', () => {
    /** What another tab writing the ownership record looks like from this one. */
    const writeFromOtherTab = (newValue: string | null) => {
      const key = localDataKey
      const oldValue = localStorage.getItem(key)
      if (newValue === null) {
        localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, newValue)
      }
      window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }))
    }

    it('stop using A’s data as soon as another tab starts moving the device to B', async () => {
      await boot()
      bindLocalData('user-a')
      writeFromOtherTab(
        JSON.stringify({
          ...record(),
          switchingTo: 'slot-b',
          slots: { ...record().slots, 'slot-b': { owner: 'user-b' } },
        }),
      )
      expect(isReady()).toBe(false)
      expect(isLocalDataOwnedBy('user-a')).toBe(false)
      expect(reload).toHaveBeenCalledTimes(1)
    })

    it('stop using A’s data when another tab made another slot active, or wiped the device', async () => {
      await boot()
      bindLocalData('user-a')
      writeFromOtherTab(JSON.stringify({ ...record(), active: 'slot-b' }))
      expect(isReady()).toBe(false)

      await boot()
      writeFromOtherTab(null)
      expect(isReady()).toBe(false)
      expect(reload).toHaveBeenCalledTimes(2)
    })

    describe('a tab loading while another switches the device to B', () => {
      const slotB = 'b0000000-0000-4000-8000-000000000000'
      const filenameB = `thunderbolt-sync-${slotB}.db`

      /** Hold a Web Lock as another tab would, until `release`. Resolves once it is held. */
      const holdLock = async (name: string) => {
        const held = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        void navigator.locks.request(name, () => {
          held.resolve()
          return release.promise
        })
        await held.promise
        return release.resolve
      }

      /** This tab reloads (as `followOtherTabs` makes it) and boots again; `opened` fills in when it may. */
      const bootAgain = () => {
        resetLocalDataOwnerForTests()
        const opened = { filename: undefined as string | undefined }
        const opening = openLocalData().then((filename) => (opened.filename = filename))
        return { opened, opening }
      }

      /** A owns the open slot; a live tab has published a switch to B and holds the switch lock. */
      const switchingElsewhere = async () => {
        await boot()
        bindLocalData('user-a')
        const release = await holdLock('thunderbolt-local-data-switch')
        const marked = {
          ...record(),
          slots: { ...record().slots, [slotB]: { owner: 'user-b' } },
          switchingTo: slotB,
        }
        localStorage.setItem(localDataKey, JSON.stringify(marked))
        return { marked, release }
      }

      it('loads the incoming account settings after another tab finishes switching', async () => {
        const { marked, release } = await switchingElsewhere()
        useLocalSettingsStore.setState({ voiceProvider: voiceKey('voice-a-key'), recoveryPhrasePending: true })
        const { opening } = bootAgain()
        await getClock().tickAsync(0)

        // Another tab writes storage without updating this tab's already-hydrated store.
        localStorage.setItem(
          'thunderbolt-local-settings',
          JSON.stringify({
            state: { ...useLocalSettingsStore.getState(), ...stashedSettings('voice-b-key') },
            version: 1,
          }),
        )
        const { switchingTo: _done, ...moved } = marked
        localStorage.setItem(localDataKey, JSON.stringify({ ...moved, active: slotB }))
        expect(useLocalSettingsStore.getState().voiceProvider.apiKey).toBe('voice-a-key')
        release()

        await opening
        expect(bindLocalData('user-b')).toBe(true)
        expect(useLocalSettingsStore.getState().voiceProvider.apiKey).toBe('voice-b-key')
        expect(isRecoveryPhrasePending()).toBe(false)
      })

      it('preserves a switch queued while boot deletes an abandoned slot', async () => {
        await boot()
        bindLocalData('user-a')
        localStorage.setItem(
          localDataKey,
          JSON.stringify({
            ...record(),
            slots: { ...record().slots, abandoned: { owner: 'old-anonymous', anonymous: true } },
          }),
        )
        const deleting = Promise.withResolvers<void>()
        const finishDelete = Promise.withResolvers<void>()
        spyOn(platform, 'deleteIndexedDbDatabase').mockImplementation(async () => {
          deleting.resolve()
          await finishDelete.promise
        })
        const { opening } = bootAgain()
        await deleting.promise

        const switching = navigator.locks.request('thunderbolt-local-data-switch', () => {
          localStorage.setItem(
            localDataKey,
            JSON.stringify({
              ...record(),
              active: slotB,
              slots: { ...record().slots, [slotB]: { owner: 'user-b' } },
            }),
          )
        })
        await getClock().tickAsync(0)
        finishDelete.resolve()
        await Promise.all([opening, switching])

        expect(record().active).toBe(slotB)
        expect(record().slots[slotB]?.owner).toBe('user-b')
      })

      it('waits for a live switch however long it takes, then opens B’s slot, with one switch and B’s voice key', async () => {
        await boot()
        bindLocalData('user-a')
        useLocalSettingsStore.getState().setLocalSetting('voiceProvider', voiceKey('voice-a-key'))
        const slotA = record().active
        localStorage.setItem(
          localDataKey,
          JSON.stringify({
            ...record(),
            slots: { ...record().slots, [slotB]: { owner: 'user-b', settings: stashedSettings('voice-b-key') } },
          }),
        )
        // B's cleanup waits on the key-store lock, held elsewhere past any timeout.
        const releaseKeyStore = await holdLock('thunderbolt-account-key-store')
        const switched = settled()
        expect(bindLocalData('user-b')).toBe(false)
        await getClock().tickAsync(0)
        expect(record().switchingTo).toBe(slotB)

        const { opened, opening } = bootAgain()
        await getClock().tickAsync(120_000)
        expect(opened.filename).toBeUndefined()

        releaseKeyStore()
        await switched
        await opening
        expect(opened.filename).toBe(filenameB)
        expect(bindLocalData('user-b')).toBe(true)
        expect(reload).toHaveBeenCalledTimes(1)
        expect(encryption.handleFullWipe).toHaveBeenCalledTimes(1)
        expect(useLocalSettingsStore.getState().voiceProvider.apiKey).toBe('voice-b-key')
        expect(record().slots[slotA].settings.voiceProvider.apiKey).toBe('voice-a-key')
      })

      it('keeps B off A’s slot when that tab’s switch fails', async () => {
        const { marked, release } = await switchingElsewhere()
        const { opened, opening } = bootAgain()
        await getClock().tickAsync(0)
        expect(opened.filename).toBeUndefined()
        const { switchingTo: _failed, ...unchanged } = marked
        localStorage.setItem(localDataKey, JSON.stringify(unchanged))
        release()
        await opening
        expect(opened.filename).not.toBe(filenameB)
        // A's slot opens, but nothing renders until a session binds, and B's starts its own switch.
        expect(isReady()).toBe(false)
        const switched = settled()
        expect(bindLocalData('user-b')).toBe(false)
        expect(isLocalDataOwnedBy('user-b')).toBe(false)
        await switched
      })

      it('recovers at once from a tab that died mid-switch, still without letting B in', async () => {
        const { release } = await switchingElsewhere()
        // The browser releases a dead tab's locks; its marker stays behind.
        release()
        await getClock().tickAsync(0)
        const { opened, opening } = bootAgain()
        await opening
        expect(opened.filename).not.toBe(filenameB)
        expect(record().switchingTo).toBeUndefined()
        expect(isReady()).toBe(false)
        const switched = settled()
        expect(bindLocalData('user-b')).toBe(false)
        await switched
      })

      it('reloads without its own cleanup when another tab moved the device while it waited', async () => {
        const { marked, release } = await switchingElsewhere()
        const switched = settled()
        expect(bindLocalData('user-b')).toBe(false)
        const { switchingTo: _done, ...moved } = marked
        localStorage.setItem(localDataKey, JSON.stringify({ ...moved, active: slotB }))
        release()
        await switched
        expect(reload).toHaveBeenCalledTimes(1)
        expect(encryption.handleFullWipe).not.toHaveBeenCalled()
      })
    })

    it('fail, rather than switch forever, when the switch lock cannot be taken', async () => {
      await boot()
      bindLocalData('user-a')
      spyOn(console, 'error').mockImplementation(() => {})
      spyOn(navigator.locks, 'request').mockRejectedValue(new DOMException('Lock request failed', 'AbortError'))
      const failed = settled()
      expect(bindLocalData('user-b')).toBe(false)
      await failed
      expect(getLocalDataStatus()).toBe('failed')
    })

    it('still follow another tab after their own switch failed', async () => {
      await boot()
      bindLocalData('user-a')
      spyOn(console, 'error').mockImplementation(() => {})
      spyOn(encryption, 'handleFullWipe').mockRejectedValue(new Error('key store locked'))
      const failed = settled()
      expect(bindLocalData('user-b')).toBe(false)
      await failed

      writeFromOtherTab(JSON.stringify({ ...record(), active: 'slot-z' }))
      expect(reload).toHaveBeenCalledTimes(1)
    })

    it('render an owned slot signed out only once the session resolves to nobody', async () => {
      await boot()
      bindLocalData('user-a')
      await boot()
      expect(isReady()).toBe(false)
      releaseSignedOutLocalData()
      expect(isReady()).toBe(true)
    })

    it('keep working when another tab changes nothing about this tab’s slot', async () => {
      await boot()
      bindLocalData('user-a')
      writeFromOtherTab(JSON.stringify({ ...record(), slots: { ...record().slots, 'slot-z': { owner: 'user-z' } } }))
      expect(isReady()).toBe(true)
      expect(isLocalDataOwnedBy('user-a')).toBe(true)
      expect(reload).not.toHaveBeenCalled()
    })
  })
})
