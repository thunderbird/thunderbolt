import { getDb } from '@/db/database'
import { devicesTable } from '@/db/tables'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'

const currentDeviceId = uuidv7()
const pendingDeviceId1 = uuidv7()
const pendingDeviceId2 = uuidv7()

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'
const syncEnabledKey = 'powersync_sync_enabled'
const sessionStorageKey = 'pending_device_dismissed_ids'

// Re-export the real module but override isSyncEnabled to read localStorage directly,
// preventing bleed from other test files that mock.module('@/db/powersync').
const realPowersync = await import('@/db/powersync')
mock.module('@/db/powersync', () => ({
  ...realPowersync,
  isSyncEnabled: () => localStorage.getItem(syncEnabledKey) === 'true',
}))

const { usePendingDeviceNotification } = await import('./use-pending-device-notification')

const TestComponent = () => {
  const { pendingDeviceToNotify, pendingDevices, dismissDevice } = usePendingDeviceNotification()
  return (
    <div>
      <span data-testid="pending-count">{pendingDevices.length}</span>
      <span data-testid="notify-device">{pendingDeviceToNotify?.name ?? 'none'}</span>
      <span data-testid="notify-device-id">{pendingDeviceToNotify?.id ?? 'none'}</span>
      {pendingDeviceToNotify && (
        <button data-testid="dismiss" onClick={() => dismissDevice(pendingDeviceToNotify.id)}>
          Dismiss
        </button>
      )}
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
    sessionStorage.removeItem(sessionStorageKey)
  })

  afterEach(() => {
    localStorage.removeItem(deviceIdKey)
    localStorage.removeItem(authTokenKey)
    localStorage.removeItem(syncEnabledKey)
    sessionStorage.removeItem(sessionStorageKey)
    cleanup()
  })

  it('returns null when sync is not enabled', async () => {
    localStorage.removeItem(syncEnabledKey)
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      { id: pendingDeviceId1, userId: 'user-1', name: 'Pending', trusted: 0 },
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
      { id: pendingDeviceId1, userId: 'user-1', name: 'Pending', trusted: 0 },
    ])

    renderWithReactivity(<TestComponent />, { tables: ['devices'] })
    await waitForElement(() => {
      const el = screen.queryByTestId('pending-count')
      return el?.textContent === '2' ? el : null
    })

    expect(screen.getByTestId('notify-device').textContent).toBe('none')
  })

  it('returns the first pending device when conditions are met', async () => {
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      { id: pendingDeviceId1, userId: 'user-1', name: 'Pending One', trusted: 0 },
      { id: pendingDeviceId2, userId: 'user-1', name: 'Pending Two', trusted: 0 },
    ])

    renderWithReactivity(<TestComponent />, { tables: ['devices'] })
    await waitForElement(() => {
      const el = screen.queryByTestId('notify-device')
      return el?.textContent !== 'none' ? el : null
    })

    expect(screen.getByTestId('notify-device').textContent).toBe('Pending One')
  })

  it('dismisses a device and shows the next one', async () => {
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      { id: pendingDeviceId1, userId: 'user-1', name: 'Pending One', trusted: 0 },
      { id: pendingDeviceId2, userId: 'user-1', name: 'Pending Two', trusted: 0 },
    ])

    renderWithReactivity(<TestComponent />, { tables: ['devices'] })
    await waitForElement(() => {
      const el = screen.queryByTestId('notify-device')
      return el?.textContent === 'Pending One' ? el : null
    })

    fireEvent.click(screen.getByTestId('dismiss'))

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByTestId('notify-device').textContent).toBe('Pending Two')
  })

  it('persists dismissed IDs to sessionStorage', async () => {
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      { id: pendingDeviceId1, userId: 'user-1', name: 'Pending One', trusted: 0 },
    ])

    renderWithReactivity(<TestComponent />, { tables: ['devices'] })
    await waitForElement(() => {
      const el = screen.queryByTestId('notify-device')
      return el?.textContent === 'Pending One' ? el : null
    })

    fireEvent.click(screen.getByTestId('dismiss'))

    await act(async () => {
      await getClock().runAllAsync()
    })

    const stored = JSON.parse(sessionStorage.getItem(sessionStorageKey) ?? '[]')
    expect(stored).toContain(pendingDeviceId1)
  })

  it('hydrates dismissed IDs from sessionStorage on mount', async () => {
    sessionStorage.setItem(sessionStorageKey, JSON.stringify([pendingDeviceId1]))
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      { id: pendingDeviceId1, userId: 'user-1', name: 'Pending One', trusted: 0 },
      { id: pendingDeviceId2, userId: 'user-1', name: 'Pending Two', trusted: 0 },
    ])

    renderWithReactivity(<TestComponent />, { tables: ['devices'] })
    await waitForElement(() => {
      const el = screen.queryByTestId('notify-device')
      return el?.textContent !== 'none' ? el : null
    })

    expect(screen.getByTestId('notify-device').textContent).toBe('Pending Two')
  })

  it('returns null when all pending devices are dismissed', async () => {
    sessionStorage.setItem(sessionStorageKey, JSON.stringify([pendingDeviceId1]))
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: currentDeviceId, userId: 'user-1', name: 'Current', trusted: 1 },
      { id: pendingDeviceId1, userId: 'user-1', name: 'Pending One', trusted: 0 },
    ])

    renderWithReactivity(<TestComponent />, { tables: ['devices'] })
    await waitForElement(() => {
      const el = screen.queryByTestId('pending-count')
      return el?.textContent === '1' ? el : null
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

    await db.insert(devicesTable).values([{ id: pendingDeviceId1, userId: 'user-1', name: 'New Pending', trusted: 0 }])
    triggerChange(['devices'])

    await waitForElement(() => {
      const el = screen.queryByTestId('notify-device')
      return el?.textContent === 'New Pending' ? el : null
    })
  })
})
