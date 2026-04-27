/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { devicesTable } from '@/db/tables'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import '@testing-library/jest-dom'
import { cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'

const currentDeviceId = uuidv7()
const pendingDeviceId1 = uuidv7()
const pendingDeviceId2 = uuidv7()

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'
const syncEnabledKey = 'powersync_sync_enabled'

// Re-export the real module but override isSyncEnabled to read localStorage directly,
// preventing bleed from other test files that mock.module('@/db/powersync').
const realPowersync = await import('@/db/powersync')
mock.module('@/db/powersync', () => ({
  ...realPowersync,
  isSyncEnabled: () => localStorage.getItem(syncEnabledKey) === 'true',
}))

// These tests verify E2EE pending device behavior — encryption must be enabled.
const realEncryption = await import('@/db/encryption')
mock.module('@/db/encryption', () => ({
  ...realEncryption,
  isEncryptionEnabled: () => true,
}))

const { usePendingDeviceNotification } = await import('./use-pending-device-notification')

const TestComponent = () => {
  const { pendingDeviceToNotify, pendingDevices } = usePendingDeviceNotification()
  return (
    <div>
      <span data-testid="pending-count">{pendingDevices.length}</span>
      <span data-testid="notify-device">{pendingDeviceToNotify?.name ?? 'none'}</span>
      <span data-testid="notify-device-id">{pendingDeviceToNotify?.id ?? 'none'}</span>
    </div>
  )
}

describe('usePendingDeviceNotification', () => {
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
  })

  afterEach(() => {
    localStorage.removeItem(deviceIdKey)
    localStorage.removeItem(authTokenKey)
    localStorage.removeItem(syncEnabledKey)
    cleanup()
  })

  it('returns null when sync is not enabled', async () => {
    localStorage.removeItem(syncEnabledKey)
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      { id: pendingDeviceId1, userId: 'user-1', name: 'Pending', trusted: 0, approvalPending: 1 },
    ])

    renderWithReactivity(<TestComponent />, { tables: ['devices'] })
    await waitForElement(() => {
      const el = screen.queryByTestId('pending-count')
      return el?.textContent === '1' ? el : null
    })

    expect(screen.getByTestId('notify-device').textContent).toBe('none')
  })

  it('returns null when current device is not trusted', async () => {
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 0 },
      { id: pendingDeviceId1, userId: 'user-1', name: 'Pending', trusted: 0, approvalPending: 1 },
    ])

    renderWithReactivity(<TestComponent />, { tables: ['devices'] })
    await waitForElement(() => {
      const el = screen.queryByTestId('pending-count')
      return el?.textContent === '1' ? el : null
    })

    expect(screen.getByTestId('notify-device').textContent).toBe('none')
  })

  it('returns the first pending device when conditions are met', async () => {
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      { id: pendingDeviceId1, userId: 'user-1', name: 'Pending One', trusted: 0, approvalPending: 1 },
      { id: pendingDeviceId2, userId: 'user-1', name: 'Pending Two', trusted: 0, approvalPending: 1 },
    ])

    renderWithReactivity(<TestComponent />, { tables: ['devices'] })
    await waitForElement(() => {
      const el = screen.queryByTestId('notify-device')
      return el?.textContent !== 'none' ? el : null
    })

    expect(screen.getByTestId('notify-device').textContent).toBe('Pending One')
  })

  it('does not show devices without approvalPending', async () => {
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      { id: pendingDeviceId1, userId: 'user-1', name: 'Denied Device', trusted: 0, approvalPending: 0 },
    ])

    renderWithReactivity(<TestComponent />, { tables: ['devices'] })
    await waitForElement(() => {
      const el = screen.queryByTestId('pending-count')
      return el?.textContent === '0' ? el : null
    })

    expect(screen.getByTestId('notify-device').textContent).toBe('none')
  })

  it('reacts to new pending device appearing via PowerSync', async () => {
    const db = getDb()

    await db.insert(devicesTable).values([{ id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 }])

    const { triggerChange } = renderWithReactivity(<TestComponent />, { tables: ['devices'] })
    await waitForElement(() => {
      const el = screen.queryByTestId('pending-count')
      return el?.textContent === '0' ? el : null
    })

    expect(screen.getByTestId('notify-device').textContent).toBe('none')

    await db
      .insert(devicesTable)
      .values([{ id: pendingDeviceId1, userId: 'user-1', name: 'New Pending', trusted: 0, approvalPending: 1 }])
    triggerChange(['devices'])

    await waitForElement(() => {
      const el = screen.queryByTestId('notify-device')
      return el?.textContent === 'New Pending' ? el : null
    })
  })
})
