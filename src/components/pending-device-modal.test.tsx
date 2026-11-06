/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { devicesTable } from '@/db/tables'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { createMockHttpClient } from '@/test-utils/http-client'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import type { ReactNode } from 'react'
import { eq } from 'drizzle-orm'
import 'fake-indexeddb/auto'
import { createClient } from '@/lib/http'
import {
  generateKeyPair,
  generateMlKemKeyPair,
  storeKeyPair,
  clearAllKeys,
  exportPublicKey,
  exportMlKemPublicKey,
} from '@/crypto'
import { createDeviceApprovalFingerprint } from '@/crypto/device-approval-fingerprint'
import { setCachedSession, clearCachedSession } from '@/lib/session-cache'

const currentDeviceId = uuidv7()
const pendingDeviceId1 = uuidv7()

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'
const sessionStorageKey = 'pending_device_dismissed_ids'

// Defend against bleed from other test files that fully mock '@/db/powersync/sync-state'.
// `isSyncEnabled` is pinned to the real production source (useLocalSettingsStore),
// which the suite below seeds directly.
const realPowersync = await import('@/db/powersync/sync-state')
mock.module('@/db/powersync/sync-state', () => ({
  ...realPowersync,
  isSyncEnabled: () => useLocalSettingsStore.getState().syncEnabled,
}))

// Pure passthrough mock: shields this file from '@/db/encryption' overrides
// leaked by other test files (bun's mock.module leaks across files), and the
// afterAll restore keeps this file from leaking in turn. See testing.md §65.
const realEncryption = { ...(await import('@/db/encryption')) }
const realEncryptionConfig = { ...(await import('@/db/encryption/config')) }
mock.module('@/db/encryption', () => ({ ...realEncryption }))
afterAll(() => {
  mock.module('@/db/encryption', () => realEncryption)
  mock.module('@/db/encryption/config', () => realEncryptionConfig)
})

const { PendingDeviceModal } = await import('./pending-device-modal')

const HttpClientWrapper = ({ children }: { children: ReactNode }) => (
  <HttpClientProvider httpClient={createMockHttpClient()}>{children}</HttpClientProvider>
)

describe('PendingDeviceModal', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    localStorage.setItem(deviceIdKey, currentDeviceId)
    localStorage.setItem(authTokenKey, 'test-token')
    useLocalSettingsStore.setState({ syncEnabled: true })
    sessionStorage.removeItem(sessionStorageKey)
  })

  afterEach(async () => {
    await clearAllKeys()
    clearCachedSession()
    localStorage.removeItem(deviceIdKey)
    localStorage.removeItem(authTokenKey)
    useLocalSettingsStore.setState({ syncEnabled: false })
    sessionStorage.removeItem(sessionStorageKey)
    cleanup()
  })

  it('does not render modal when there are no pending devices', async () => {
    const db = getDb()

    await db.insert(devicesTable).values([{ id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 }])

    renderWithReactivity(<PendingDeviceModal />, {
      tables: ['devices'],
      wrapper: HttpClientWrapper,
    })

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.queryByText('New device waiting')).not.toBeInTheDocument()
  })

  it('renders modal with device name when pending device exists', async () => {
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      {
        id: pendingDeviceId1,
        userId: 'user-1',
        name: 'My Phone',
        trusted: 0,
        approvalPending: 1,
        publicKey: 'pk-1',
        mlkemPublicKey: 'mlkem-pk-1',
      },
    ])

    renderWithReactivity(<PendingDeviceModal />, {
      tables: ['devices'],
      wrapper: HttpClientWrapper,
    })

    await waitForElement(() => screen.queryByText('New device waiting'))
    expect(screen.getByText('My Phone')).toBeInTheDocument()
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument()
  })

  it('opens confirmation dialog on Approve click', async () => {
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      {
        id: pendingDeviceId1,
        userId: 'user-1',
        name: 'My Phone',
        trusted: 0,
        approvalPending: 1,
        publicKey: 'pk-1',
        mlkemPublicKey: 'mlkem-pk-1',
      },
    ])

    renderWithReactivity(<PendingDeviceModal />, {
      tables: ['devices'],
      wrapper: HttpClientWrapper,
    })

    await waitForElement(() => screen.queryByText('New device waiting'))

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByText('Approve this device?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This will share your encryption key with the device, allowing it to decrypt and sync your data.',
      ),
    ).toBeInTheDocument()
  })

  it('keeps the opened recipient snapshot when its keys and the pending-device order change', async () => {
    const db = getDb()
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    await storeKeyPair(ecdh.privateKey, ecdh.publicKey, mlkem.publicKey, mlkem.secretKey)
    setCachedSession({ user: { id: 'user-1' } })
    const publicKey = await exportPublicKey(ecdh.publicKey)
    const mlkemPublicKey = exportMlKemPublicKey(mlkem.publicKey)
    const fingerprint = await createDeviceApprovalFingerprint({
      userId: 'user-1',
      deviceId: pendingDeviceId1,
      ecdhPublicKey: publicKey,
      mlkemPublicKey,
    })
    const requests: string[] = []
    const envelopeRequested = Promise.withResolvers<void>()
    const httpClient = createClient({
      prefixUrl: 'http://test-api.local',
      fetch: async (request) => {
        const path = new URL(request instanceof Request ? request.url : String(request)).pathname
        requests.push(path)
        if (path === '/devices/me/envelope') {
          envelopeRequested.resolve()
        }
        return Response.json({ error: 'Test stops at the envelope boundary' }, { status: 404 })
      },
    })
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <HttpClientProvider httpClient={httpClient}>{children}</HttpClientProvider>
    )
    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      {
        id: pendingDeviceId1,
        userId: 'user-1',
        name: 'Original',
        trusted: 0,
        approvalPending: 1,
        publicKey,
        mlkemPublicKey,
      },
    ])
    renderWithReactivity(<PendingDeviceModal />, { tables: ['devices'], wrapper: Wrapper })
    await waitForElement(() => screen.queryByText('New device waiting'))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await act(async () => {
      await db
        .update(devicesTable)
        .set({ publicKey: 'replaced-ecdh', mlkemPublicKey: 'replaced-mlkem' })
        .where(eq(devicesTable.id, pendingDeviceId1))
      await db.insert(devicesTable).values({
        id: uuidv7(),
        userId: 'user-1',
        name: 'Another pending device',
        trusted: 0,
        approvalPending: 1,
        publicKey: 'another',
        mlkemPublicKey: 'another',
        createdAt: '2000-01-01T00:00:00Z',
      })
      await getClock().runAllAsync()
    })
    fireEvent.change(screen.getByLabelText('Device fingerprint'), { target: { value: fingerprint } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
      await envelopeRequested.promise
    })
    await waitForElement(() => screen.queryByRole('alert'))
    expect(requests).toContain('/devices/me/envelope')
    expect(requests.filter((path) => path === '/devices/me/envelope')).toHaveLength(1)
  })

  it('opens deny confirmation dialog on Deny click', async () => {
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      {
        id: pendingDeviceId1,
        userId: 'user-1',
        name: 'My Phone',
        trusted: 0,
        approvalPending: 1,
        publicKey: 'pk-1',
        mlkemPublicKey: 'mlkem-pk-1',
      },
    ])

    renderWithReactivity(<PendingDeviceModal />, {
      tables: ['devices'],
      wrapper: HttpClientWrapper,
    })

    await waitForElement(() => screen.queryByText('New device waiting'))

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByText('Deny this device?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This will deny the device access to your encrypted data. The device will need to set up sync again.',
      ),
    ).toBeInTheDocument()
  })

  it('does not render modal when sync is disabled', async () => {
    useLocalSettingsStore.setState({ syncEnabled: false })
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      {
        id: pendingDeviceId1,
        userId: 'user-1',
        name: 'My Phone',
        trusted: 0,
        approvalPending: 1,
        publicKey: 'pk-1',
        mlkemPublicKey: 'mlkem-pk-1',
      },
    ])

    renderWithReactivity(<PendingDeviceModal />, {
      tables: ['devices'],
      wrapper: HttpClientWrapper,
    })

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.queryByText('New device waiting')).not.toBeInTheDocument()
  })
})
