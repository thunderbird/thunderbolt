/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { devicesTable } from '@/db/tables'
import type { Device } from '@/dal'
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

/** Creates an HTTP client that records every request before returning a fixture response. */
const createRecordingHttpClient = (respond: (request: Request) => Response | Promise<Response>) => {
  const requests: Request[] = []
  const httpClient = createClient({
    prefixUrl: 'http://test-api.local/v1',
    fetch: async (request) => {
      const captured = request as Request
      requests.push(captured.clone())
      return respond(captured)
    },
  })

  return { httpClient, requests }
}

/** Creates an HTTP client that records bridge-removal requests and returns one contract response. */
const createRemovalHttpClient = (status = 200) => {
  const responseBody =
    status === 200
      ? { success: true }
      : { error: status === 404 ? 'Device not found' : 'Only revoked bridge devices can be removed' }

  return createRecordingHttpClient(
    () =>
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
}

/** Creates a pre-E2EE trusted-app client that records the confirmed CLI revoke request. */
const createCliRevokeHttpClient = () =>
  createRecordingHttpClient((request) =>
    request.method === 'GET'
      ? Response.json({ error: 'Canary not found' }, { status: 404 })
      : new Response(null, { status: 204 }),
  )

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
    const bridgeCard = screen.getByText('Home Bridge').closest<HTMLElement>('[data-slot="card"]')
    expect(bridgeCard).not.toBeNull()
    expect(within(bridgeCard!).getByText('Bridge')).toBeInTheDocument()
    expect(within(bridgeCard!).getByText('Accepts connections from your devices')).toBeInTheDocument()
    expect(within(bridgeCard!).getByText('Pairing identity')).toBeInTheDocument()
    expect(within(bridgeCard!).getByRole('button', { name: 'Set up pairing for Home Bridge' })).toBeEnabled()

    // A bridge is just a device: the non-current bridge owns the only revoke button, it is enabled,
    // and clicking it opens the revoke confirmation dialog for that bridge.
    const revokeButton = screen.getByRole('button', { name: /Revoke/ })
    expect(revokeButton).toBeEnabled()

    fireEvent.click(revokeButton)
    await waitForElement(() => screen.queryByText('Revoke this device?'))
    expect(screen.getByText('Revoke this device?')).toBeInTheDocument()
  })

  it('keeps pairing controls for normal, legacy-null, and bridge devices', async () => {
    await getDb()
      .insert(devicesTable)
      .values([
        {
          id: uuidv7(),
          userId: 'user-1',
          name: 'Normal Device',
          lastSeen: new Date().toISOString(),
          trusted: 1,
          deviceType: 'normal',
          nodeId: 'normal-node-id',
        },
        {
          id: uuidv7(),
          userId: 'user-1',
          name: 'Legacy Device',
          lastSeen: new Date().toISOString(),
          trusted: 1,
        },
        {
          id: uuidv7(),
          userId: 'user-1',
          name: 'Pairing Bridge',
          lastSeen: new Date().toISOString(),
          trusted: 1,
          deviceType: 'bridge',
          nodeId: 'bridge-node-id',
        },
      ])

    renderDevicesPage()

    await waitForElement(() => screen.queryByText('Normal Device'))
    expect(screen.getByRole('button', { name: 'Show QR code for Normal Device' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Update pairing for Normal Device' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Set up pairing for Legacy Device' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Show QR code for Pairing Bridge' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Update pairing for Pairing Bridge' })).toBeEnabled()
  })

  it('renders an active CLI row with its state and revoke action only', async () => {
    const cliDeviceId = uuidv7()
    const { httpClient, requests } = createCliRevokeHttpClient()
    await getDb().insert(devicesTable).values({
      id: cliDeviceId,
      userId: 'user-1',
      name: 'Terminal CLI',
      trusted: 1,
      deviceType: 'cli',
      nodeId: 'unexpected-cli-node-id',
      lastSeen: new Date().toISOString(),
    })

    renderDevicesPage(httpClient)

    await waitForElement(() => screen.queryByText('Terminal CLI'))
    const activeCard = screen.getByText('Terminal CLI').closest<HTMLElement>('[data-slot="card"]')

    expect(activeCard).not.toBeNull()
    expect(within(activeCard!).getByText('CLI')).toBeInTheDocument()
    expect(within(activeCard!).getByText('Active')).toBeInTheDocument()
    expect(within(activeCard!).getByText(/^Last seen /)).toBeInTheDocument()
    expect(within(activeCard!).getByRole('button', { name: 'Revoke Terminal CLI' })).toBeEnabled()
    expect(within(activeCard!).queryByText('Pairing identity')).not.toBeInTheDocument()
    expect(within(activeCard!).queryByRole('button', { name: /pairing|QR|Remove/i })).not.toBeInTheDocument()

    fireEvent.click(within(activeCard!).getByRole('button', { name: 'Revoke Terminal CLI' }))
    await waitForElement(() => screen.queryByText('Revoke this CLI?'))
    expect(screen.getByText('Revoke this CLI?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.method).toBe('GET')
    expect(new URL(requests[0]!.url).pathname).toBe('/v1/encryption/canary')
    expect(requests[1]?.method).toBe('POST')
    expect(new URL(requests[1]!.url).pathname).toBe(`/v1/account/devices/${cliDeviceId}/revoke`)
    expect(await requests[1]!.json()).toEqual({})
    expect(screen.queryByText('Revoke this CLI?')).not.toBeInTheDocument()
  })

  it('renders a revoked CLI row with its state and no actions', async () => {
    await getDb().insert(devicesTable).values({
      id: uuidv7(),
      userId: 'user-1',
      name: 'Revoked CLI',
      trusted: 1,
      deviceType: 'cli',
      nodeId: 'unexpected-revoked-cli-node-id',
      revokedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    })

    renderDevicesPage()

    await waitForElement(() => screen.queryByText('Revoked CLI'))
    const revokedCard = screen.getByText('Revoked CLI').closest<HTMLElement>('[data-slot="card"]')

    expect(revokedCard).not.toBeNull()
    expect(within(revokedCard!).getByText('CLI')).toBeInTheDocument()
    expect(within(revokedCard!).getByText('Revoked')).toBeInTheDocument()
    expect(within(revokedCard!).getByText(/^Last seen /)).toBeInTheDocument()
    expect(within(revokedCard!).queryByText('Pairing identity')).not.toBeInTheDocument()
    expect(within(revokedCard!).queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders an unknown device type without pairing or removal controls', async () => {
    await getDb()
      .insert(devicesTable)
      .values({
        id: uuidv7(),
        userId: 'user-1',
        name: 'Future Device',
        trusted: 1,
        deviceType: 'future-device' as Device['deviceType'],
        nodeId: 'future-node-id',
        lastSeen: new Date().toISOString(),
      })

    renderDevicesPage()

    await waitForElement(() => screen.queryByText('Future Device'))
    const card = screen.getByText('Future Device').closest<HTMLElement>('[data-slot="card"]')

    expect(card).not.toBeNull()
    expect(within(card!).getByText(/^Last seen /)).toBeInTheDocument()
    expect(within(card!).getByRole('button', { name: 'Revoke Future Device' })).toBeEnabled()
    expect(within(card!).queryByText('Pairing identity')).not.toBeInTheDocument()
    expect(within(card!).queryByRole('button', { name: /pairing|QR|Remove/i })).not.toBeInTheDocument()
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
