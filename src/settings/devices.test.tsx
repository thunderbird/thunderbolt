/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/lib/dayjs'
import { getDb } from '@/db/database'
import { devicesTable } from '@/db/tables'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { createClient, type HttpClient } from '@/lib/http'
import { createMockHttpClient } from '@/test-utils/http-client'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { ReactNode } from 'react'

const deviceId1 = uuidv7()
const deviceId2 = uuidv7()

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'
const removalErrors = [
  [404, 'Device not found'],
  [409, 'Only revoked bridge devices can be removed'],
] as const

import DevicesSettingsPage from './devices'

/** Renders Devices settings with an injected HTTP boundary. */
const renderDevicesPage = (httpClient: HttpClient = createMockHttpClient()) => {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <HttpClientProvider httpClient={httpClient}>{children}</HttpClientProvider>
  )

  return renderWithReactivity(<DevicesSettingsPage />, {
    tables: ['devices'],
    wrapper: Wrapper,
  })
}

/** Creates an HTTP client that records bridge-removal requests and returns one contract response. */
const createRemovalHttpClient = (status = 200) => {
  const requests: Request[] = []
  const responseBody =
    status === 200
      ? { success: true }
      : { error: status === 404 ? 'Device not found' : 'Only revoked bridge devices can be removed' }
  const httpClient = createClient({
    prefixUrl: 'http://test-api.local/v1',
    fetch: async (request) => {
      requests.push(request as Request)
      return new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  return { httpClient, requests }
}

/** Inserts one visible revoked bridge row. */
const insertRevokedBridge = async (id: string) => {
  await getDb().insert(devicesTable).values({
    id,
    userId: 'user-1',
    name: 'Revoked Bridge',
    lastSeen: new Date().toISOString(),
    trusted: 1,
    deviceType: 'bridge',
    revokedAt: new Date().toISOString(),
  })
}

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

    const { triggerChange } = renderDevicesPage()

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

    renderDevicesPage()

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

  it('renders Remove only for revoked bridge devices', async () => {
    const db = getDb()
    await db.insert(devicesTable).values([
      {
        id: uuidv7(),
        userId: 'user-1',
        name: 'Revoked Bridge',
        lastSeen: new Date().toISOString(),
        trusted: 1,
        deviceType: 'bridge',
        revokedAt: new Date().toISOString(),
      },
      {
        id: uuidv7(),
        userId: 'user-1',
        name: 'Active Bridge',
        lastSeen: new Date().toISOString(),
        trusted: 1,
        deviceType: 'bridge',
      },
      {
        id: uuidv7(),
        userId: 'user-1',
        name: 'Revoked Normal Device',
        lastSeen: new Date().toISOString(),
        trusted: 1,
        deviceType: 'normal',
        revokedAt: new Date().toISOString(),
      },
      {
        id: uuidv7(),
        userId: 'user-1',
        name: 'Active Normal Device',
        lastSeen: new Date().toISOString(),
        trusted: 1,
        deviceType: 'normal',
      },
    ])

    renderDevicesPage()

    await waitForElement(() => screen.queryByText('Revoked Bridge'))

    const revokedBridgeCard = screen.getByText('Revoked Bridge').closest<HTMLElement>('[data-slot="card"]')
    const activeBridgeCard = screen.getByText('Active Bridge').closest<HTMLElement>('[data-slot="card"]')
    const revokedNormalCard = screen.getByText('Revoked Normal Device').closest<HTMLElement>('[data-slot="card"]')
    const activeNormalCard = screen.getByText('Active Normal Device').closest<HTMLElement>('[data-slot="card"]')

    expect(revokedBridgeCard).not.toBeNull()
    expect(activeBridgeCard).not.toBeNull()
    expect(revokedNormalCard).not.toBeNull()
    expect(activeNormalCard).not.toBeNull()
    expect(within(revokedBridgeCard!).getByRole('button', { name: 'Remove' })).toBeEnabled()
    expect(within(activeBridgeCard!).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(within(revokedNormalCard!).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(within(activeNormalCard!).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })

  it('removes a revoked bridge through the devices endpoint', async () => {
    const revokedBridgeId = uuidv7()
    const { httpClient, requests } = createRemovalHttpClient()
    await insertRevokedBridge(revokedBridgeId)

    renderDevicesPage(httpClient)

    await waitForElement(() => screen.queryByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitForElement(() => screen.queryByText('Remove this bridge?'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('DELETE')
    expect(new URL(requests[0]!.url).pathname).toBe(`/v1/devices/${revokedBridgeId}`)
    expect(screen.queryByText('Remove this bridge?')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  for (const [status, message] of removalErrors) {
    it(`surfaces the ${status} removal error`, async () => {
      const revokedBridgeId = uuidv7()
      const { httpClient } = createRemovalHttpClient(status)
      await insertRevokedBridge(revokedBridgeId)

      renderDevicesPage(httpClient)

      await waitForElement(() => screen.queryByRole('button', { name: 'Remove' }))
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

      await waitForElement(() => screen.queryByText('Remove this bridge?'))
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

      const errorAlert = await waitForElement(() => screen.queryByRole('alert'))
      expect(screen.queryByText('Remove this bridge?')).not.toBeInTheDocument()
      expect(errorAlert).toHaveTextContent(message)
    })
  }
})
