import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { _clearCache, setMasterKey } from './master-key'
import { exportKeyBytes, generateMasterKey } from './primitives'
import { SyncState, _clearCallbacks, disableSync, enableSync, getSyncState, onSyncEnabled } from './sync-gate'

describe('sync gate', () => {
  beforeEach(() => {
    localStorage.clear()
    _clearCache()
    _clearCallbacks()
  })

  afterEach(() => {
    localStorage.clear()
    _clearCache()
    _clearCallbacks()
  })

  test('getSyncState returns DISABLED by default', () => {
    expect(getSyncState()).toBe(SyncState.DISABLED)
  })

  test('enableSync returns REQUIRES_KEY_SETUP when no key', () => {
    const result = enableSync()
    expect(result).toEqual({ status: 'REQUIRES_KEY_SETUP' })
    expect(getSyncState()).toBe(SyncState.DISABLED)
  })

  test('enableSync returns ENABLED when key is present', async () => {
    const key = await generateMasterKey()
    await setMasterKey(await exportKeyBytes(key))

    const result = enableSync()
    expect(result).toEqual({ status: 'ENABLED' })
    expect(getSyncState()).toBe(SyncState.ENABLED)
  })

  test('enableSync fires onSyncEnabled callbacks', async () => {
    const key = await generateMasterKey()
    await setMasterKey(await exportKeyBytes(key))

    const callback = mock(() => {})
    onSyncEnabled(callback)

    enableSync()
    expect(callback).toHaveBeenCalledTimes(1)
  })

  test('disableSync sets state to DISABLED', async () => {
    const key = await generateMasterKey()
    await setMasterKey(await exportKeyBytes(key))
    enableSync()

    disableSync()
    expect(getSyncState()).toBe(SyncState.DISABLED)
  })

  test('disableSync does not clear the key', async () => {
    const key = await generateMasterKey()
    await setMasterKey(await exportKeyBytes(key))
    enableSync()

    disableSync()
    expect(localStorage.getItem('thunderbolt_enc_key')).not.toBeNull()
  })

  test('onSyncEnabled returns unsubscribe function', async () => {
    const key = await generateMasterKey()
    await setMasterKey(await exportKeyBytes(key))

    const callback = mock(() => {})
    const unsubscribe = onSyncEnabled(callback)
    unsubscribe()

    enableSync()
    expect(callback).not.toHaveBeenCalled()
  })
})
