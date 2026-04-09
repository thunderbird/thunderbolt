import '@/lib/dayjs'
import { getDb } from '@/db/database'
import { devicesTable } from '@/db/tables'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { createMockHttpClient } from '@/test-utils/http-client'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, screen } from '@testing-library/react'
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
})
