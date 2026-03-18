import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  KeyState,
  _clearCache,
  clearMasterKey,
  getKeyState,
  getMasterKey,
  getSalt,
  getStartupAction,
  hasMasterKey,
  setMasterKey,
  setSalt,
} from './master-key'
import { exportKeyBytes, generateMasterKey } from './primitives'

describe('master key manager', () => {
  beforeEach(() => {
    localStorage.clear()
    _clearCache()
  })

  afterEach(() => {
    localStorage.clear()
    _clearCache()
  })

  test('getMasterKey returns null when no key stored', async () => {
    expect(await getMasterKey()).toBeNull()
  })

  test('setMasterKey + getMasterKey round-trip', async () => {
    const key = await generateMasterKey()
    const keyBytes = await exportKeyBytes(key)

    await setMasterKey(keyBytes)

    const retrieved = await getMasterKey()
    expect(retrieved).not.toBeNull()
    const retrievedBytes = await exportKeyBytes(retrieved!)
    expect(retrievedBytes).toEqual(keyBytes)
  })

  test('getMasterKey caches the key', async () => {
    const key = await generateMasterKey()
    await setMasterKey(await exportKeyBytes(key))

    const first = await getMasterKey()
    const second = await getMasterKey()
    expect(first).toBe(second) // same reference
  })

  test('setMasterKey writes correct storage keys', async () => {
    const key = await generateMasterKey()
    await setMasterKey(await exportKeyBytes(key))

    expect(localStorage.getItem('thunderbolt_enc_key')).not.toBeNull()
    expect(localStorage.getItem('thunderbolt_enc_version')).toBe('v1')
    expect(localStorage.getItem('thunderbolt_key_state')).toBe('KEY_PRESENT')
  })

  test('clearMasterKey removes all thunderbolt keys and cache', async () => {
    const key = await generateMasterKey()
    await setMasterKey(await exportKeyBytes(key))

    clearMasterKey()

    expect(await getMasterKey()).toBeNull()
    expect(localStorage.getItem('thunderbolt_enc_key')).toBeNull()
    expect(localStorage.getItem('thunderbolt_key_state')).toBeNull()
  })

  test('setSalt and getSalt round-trip', () => {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    setSalt(salt)
    expect(getSalt()).toEqual(salt)
  })

  test('getSalt returns null when no salt stored', () => {
    expect(getSalt()).toBeNull()
  })
})

describe('hasMasterKey', () => {
  beforeEach(() => {
    localStorage.clear()
    _clearCache()
  })

  afterEach(() => {
    localStorage.clear()
    _clearCache()
  })

  test('returns false for NO_KEY', () => {
    expect(hasMasterKey()).toBe(false)
  })

  test('returns true for KEY_PRESENT', async () => {
    const key = await generateMasterKey()
    await setMasterKey(await exportKeyBytes(key))
    expect(hasMasterKey()).toBe(true)
  })

  test('returns true for KEY_LOCKED', () => {
    localStorage.setItem('thunderbolt_key_state', 'KEY_LOCKED')
    expect(hasMasterKey()).toBe(true)
  })
})

describe('getKeyState', () => {
  beforeEach(() => {
    localStorage.clear()
    _clearCache()
  })

  afterEach(() => {
    localStorage.clear()
    _clearCache()
  })

  test('returns NO_KEY when absent', () => {
    expect(getKeyState()).toBe(KeyState.NO_KEY)
  })

  test('returns KEY_PRESENT after setMasterKey', async () => {
    const key = await generateMasterKey()
    await setMasterKey(await exportKeyBytes(key))
    expect(getKeyState()).toBe(KeyState.KEY_PRESENT)
  })

  test('returns KEY_LOCKED when set directly', () => {
    localStorage.setItem('thunderbolt_key_state', 'KEY_LOCKED')
    expect(getKeyState()).toBe(KeyState.KEY_LOCKED)
  })
})

describe('getStartupAction', () => {
  beforeEach(() => {
    localStorage.clear()
    _clearCache()
  })

  afterEach(() => {
    localStorage.clear()
    _clearCache()
  })

  test('returns NO_KEY when no key state', () => {
    expect(getStartupAction()).toBe('NO_KEY')
  })

  test('returns READY when KEY_PRESENT', async () => {
    const key = await generateMasterKey()
    await setMasterKey(await exportKeyBytes(key))
    expect(getStartupAction()).toBe('READY')
  })

  test('returns REQUIRES_UNLOCK when KEY_LOCKED', () => {
    localStorage.setItem('thunderbolt_key_state', 'KEY_LOCKED')
    expect(getStartupAction()).toBe('REQUIRES_UNLOCK')
  })
})
