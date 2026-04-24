import { getDb } from '@/db/database'
import { devicesTable } from '@/db/tables'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { createMockHttpClient } from '@/test-utils/http-client'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import type { ReactNode } from 'react'

const currentDeviceId = uuidv7()
const pendingDeviceId1 = uuidv7()

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'
const syncEnabledKey = 'powersync_sync_enabled'
const sessionStorageKey = 'pending_device_dismissed_ids'

// Re-export real powersync module with localStorage-based isSyncEnabled to prevent
// bleed from other test files that mock.module('@/db/powersync').
const realPowersync = await import('@/db/powersync')
mock.module('@/db/powersync', () => ({
  ...realPowersync,
  isSyncEnabled: () => localStorage.getItem('powersync_sync_enabled') === 'true',
}))

// These tests verify E2EE pending device behavior — encryption must be enabled.
const realEncryption = await import('@/db/encryption')
mock.module('@/db/encryption', () => ({
  ...realEncryption,
  isEncryptionEnabled: () => true,
}))

mock.module('@/hooks/use-approve-device', () => ({
  useApproveDevice: () => ({ mutate: mock(), isPending: false }),
}))

mock.module('@/hooks/use-revoke-device', () => ({
  useRevokeDevice: () => ({ mutate: mock(), isPending: false }),
}))

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
    localStorage.setItem(syncEnabledKey, 'true')
    sessionStorage.removeItem(sessionStorageKey)
  })

  afterEach(() => {
    localStorage.removeItem(deviceIdKey)
    localStorage.removeItem(authTokenKey)
    localStorage.removeItem(syncEnabledKey)
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
    localStorage.removeItem(syncEnabledKey)
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
