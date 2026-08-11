/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { useConfigStore } from '@/api/config-store'
import { type HttpClient } from '@/contexts'
import { generateAK, storeAK, storeWrappedDEK } from '@/crypto'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useRevokeDevice } from './use-revoke-device'

const newPhrase = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima'

const createDeps = () => ({
  revokeAndRotate: mock(async (_httpClient: HttpClient, _deviceId: string) => newPhrase),
  revokePlain: mock(async (_httpClient: HttpClient, _deviceId: string) => {}),
})

const deleteKeyDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('thunderbolt-keys')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

/** Seed a complete v2 key hierarchy so the REAL isE2eeReady reads "ready". */
const seedKeys = async () => {
  await storeAK(await generateAK())
  await storeWrappedDEK('0', 'd3JhcHBlZA==')
}

describe('useRevokeDevice', () => {
  beforeEach(async () => {
    await deleteKeyDatabase()
    // Drive the REAL isE2eeReady via the config store + fake IndexedDB instead
    // of mocking '@/db/encryption' (module mocks on it leak across files).
    useConfigStore.setState({ config: { e2eeEnabled: true } })
  })

  afterEach(() => {
    useConfigStore.setState({ config: {} })
  })

  it('revokes with double rotation and resolves the new recovery phrase when E2EE is active', async () => {
    await seedKeys()
    const { revokeAndRotate, revokePlain } = createDeps()

    const { result } = renderHook(() => useRevokeDevice({ revokeAndRotate, revokePlain }), {
      wrapper: createQueryTestWrapper(),
    })

    const resolved = await act(async () => result.current.mutateAsync('device-1'))

    expect(resolved).toBe(newPhrase)
    expect(revokeAndRotate).toHaveBeenCalledTimes(1)
    expect(revokeAndRotate.mock.calls[0]?.[1]).toBe('device-1')
    expect(revokePlain).not.toHaveBeenCalled()
  })

  it('falls back to a plain revoke (no rotation, null phrase) before v2 setup is complete', async () => {
    const { revokeAndRotate, revokePlain } = createDeps()

    const { result } = renderHook(() => useRevokeDevice({ revokeAndRotate, revokePlain }), {
      wrapper: createQueryTestWrapper(),
    })

    const resolved = await act(async () => result.current.mutateAsync('device-1'))

    expect(resolved).toBeNull()
    expect(revokePlain).toHaveBeenCalledTimes(1)
    expect(revokeAndRotate).not.toHaveBeenCalled()
  })

  it('falls back to a plain revoke for pre-E2EE accounts (feature disabled)', async () => {
    useConfigStore.setState({ config: {} })
    await seedKeys()
    const { revokeAndRotate, revokePlain } = createDeps()

    const { result } = renderHook(() => useRevokeDevice({ revokeAndRotate, revokePlain }), {
      wrapper: createQueryTestWrapper(),
    })

    const resolved = await act(async () => result.current.mutateAsync('device-1'))

    expect(resolved).toBeNull()
    expect(revokePlain).toHaveBeenCalledTimes(1)
    expect(revokeAndRotate).not.toHaveBeenCalled()
  })
})
