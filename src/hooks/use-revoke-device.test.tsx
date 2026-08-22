/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { useConfigStore } from '@/api/config-store'
import type { HttpClient } from '@/contexts'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { generateAK, storeAK, storeDEK } from '@/crypto'
import { createMockHttpClient } from '@/test-utils/http-client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { useRevokeDevice } from './use-revoke-device'

const deleteKeyDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('thunderbolt-keys')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
    <HttpClientProvider httpClient={createMockHttpClient()}>{children}</HttpClientProvider>
  </QueryClientProvider>
)

describe('useRevokeDevice', () => {
  beforeEach(async () => {
    await deleteKeyDatabase()
    useConfigStore.setState({ config: { e2eeEnabled: true } })
  })

  afterEach(cleanup)

  it('revokes-and-rotates silently when E2EE is ready', async () => {
    await storeAK(await generateAK())
    await storeDEK('0', 'd3JhcHBlZA==')

    let rotatedFor = ''
    const revokeAndRotate = async (_client: HttpClient, deviceId: string): Promise<void> => {
      rotatedFor = deviceId
    }
    const revokePlain = async (): Promise<void> => {
      throw new Error('should not take the plain path')
    }

    const { result } = renderHook(() => useRevokeDevice({ revokeAndRotate, revokePlain }), { wrapper })
    let resolved: unknown = 'unset'
    await act(async () => {
      resolved = await result.current.mutateAsync('device-1')
    })

    expect(rotatedFor).toBe('device-1')
    expect(resolved).toBeUndefined()
  })

  it('falls back to a plain revoke when E2EE is not set up', async () => {
    let plainFor = ''
    const revokeAndRotate = async (): Promise<void> => {
      throw new Error('should not rotate')
    }
    const revokePlain = async (_client: HttpClient, deviceId: string): Promise<void> => {
      plainFor = deviceId
    }

    const { result } = renderHook(() => useRevokeDevice({ revokeAndRotate, revokePlain }), { wrapper })
    let resolved: unknown = 'unset'
    await act(async () => {
      resolved = await result.current.mutateAsync('device-2')
    })

    expect(plainFor).toBe('device-2')
    expect(resolved).toBeUndefined()
  })
})
