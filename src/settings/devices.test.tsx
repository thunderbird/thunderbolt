/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/lib/dayjs'
import { getDb } from '@/db/database'
import { devicesTable } from '@/db/tables'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { createMockHttpClient } from '@/test-utils/http-client'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { ReactNode } from 'react'

const deviceId1 = uuidv7()
const deviceId2 = uuidv7()

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'

import DevicesSettingsPage from './devices'

const HttpClientWrapper = ({ children }: { children: ReactNode }) => (
  <HttpClientProvider httpClient={createMockHttpClient()}>{children}</HttpClientProvider>
)

describe('DevicesSettingsPage reactivity', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    localStorage.setItem(deviceIdKey, deviceId1)
    localStorage.setItem(authTokenKey, 'test-token')
  })

  afterEach(() => {
    localStorage.removeItem(deviceIdKey)
    localStorage.removeItem(authTokenKey)
    cleanup()
  })

  it('updates when devices table changes (revocation)', async () => {
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: deviceId1, userId: 'user-1', name: 'This Device', lastSeen: new Date().toISOString(), trusted: 1 },
      { id: deviceId2, userId: 'user-1', name: 'Other Device', lastSeen: new Date().toISOString(), trusted: 1 },
    ])

    const { triggerChange } = renderWithReactivity(<DevicesSettingsPage />, {
      tables: ['devices'],
      wrapper: HttpClientWrapper,
    })

    await waitForElement(() => screen.queryByText('Other Device'))
    expect(screen.getByText('Other Device')).toBeInTheDocument()
    expect(screen.queryByText('Revoked')).not.toBeInTheDocument()

    await db.update(devicesTable).set({ revokedAt: new Date().toISOString() }).where(eq(devicesTable.id, deviceId2))
    triggerChange(['devices'])

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByText('Revoked')).toBeInTheDocument()
  })

  it('distinguishes a bridge device and keeps its revoke path available', async () => {
    const db = getDb()

    await db.insert(devicesTable).values([
      { id: deviceId1, userId: 'user-1', name: 'This Device', lastSeen: new Date().toISOString(), trusted: 1 },
      {
        id: deviceId2,
        userId: 'user-1',
        name: 'Home Bridge',
        lastSeen: new Date().toISOString(),
        trusted: 1,
        deviceType: 'bridge',
      },
    ])

    renderWithReactivity(<DevicesSettingsPage />, {
      tables: ['devices'],
      wrapper: HttpClientWrapper,
    })

    await waitForElement(() => screen.queryByText('Home Bridge'))
    expect(screen.getByText('Bridge')).toBeInTheDocument()
    expect(screen.getByText('Accepts connections from your devices')).toBeInTheDocument()

    // A bridge is just a device: the non-current bridge owns the only revoke button, it is enabled,
    // and clicking it opens the revoke confirmation dialog for that bridge.
    const revokeButton = screen.getByRole('button', { name: /Revoke/ })
    expect(revokeButton).toBeEnabled()

    fireEvent.click(revokeButton)
    await waitForElement(() => screen.queryByText('Revoke this device?'))
    expect(screen.getByText('Revoke this device?')).toBeInTheDocument()
  })
})
