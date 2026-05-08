/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'

// ---- module mocks (must come before component import) ----

mock.module('@/hooks/use-settings', () => ({
  useSettings: () => ({
    preferredName: { value: '', setValue: mock() },
    locationName: { value: '', setValue: mock() },
    locationLat: { value: '', setValue: mock() },
    locationLng: { value: '', setValue: mock() },
    dataCollection: { value: true, setValue: mock() },
    experimentalFeatureTasks: { value: false, setValue: mock() },
    hapticsEnabled: { value: true, setValue: mock() },
    distanceUnit: { value: 'imperial', setValue: mock() },
    temperatureUnit: { value: 'f', setValue: mock() },
    dateFormat: { value: 'MM/DD/YYYY', setValue: mock() },
    timeFormat: { value: '12h', setValue: mock() },
    currency: { value: 'USD', setValue: mock() },
    save: mock(),
    reset: mock(),
    isDirty: false,
  }),
}))

mock.module('@/hooks/use-sync-enabled-toggle', () => ({
  useSyncEnabledToggle: () => ({
    syncEnabled: false,
    syncSetupOpen: false,
    setSyncSetupOpen: mock(),
    handleSyncToggle: mock(),
    handleSyncSetupComplete: mock(),
  }),
}))

mock.module('@/hooks/use-powersync-status', () => ({
  usePowerSyncStatus: () => ({ connectionStatus: 'connected' }),
}))

mock.module('@/lib/posthog', () => ({
  trackEvent: mock(),
  useTelemetryAvailable: () => true,
}))

mock.module('@/hooks/use-country-units', () => ({
  useCountryUnits: () => ({ fetchCountryUnits: mock() }),
}))

mock.module('@/hooks/use-units-options', () => ({
  useUnitsOptions: () => ({
    distanceOptions: [],
    temperatureOptions: [],
    dateFormatOptions: [],
    timeFormatOptions: [],
    currencyOptions: [],
  }),
}))

mock.module('posthog-js/react', () => ({
  usePostHog: () => ({ capture: mock() }),
}))

mock.module('@/contexts/sign-in-modal-context', () => ({
  useSignInModal: () => ({ openSignInModal: mock() }),
}))

mock.module('@/components/sync-setup/sync-setup-modal', () => ({
  SyncSetupModal: () => null,
}))

mock.module('@/components/telemetry-required-modal', () => ({
  TelemetryRequiredModal: () => null,
}))

mock.module('@/components/telemetry-warning-modal', () => ({
  TelemetryWarningModal: () => null,
}))

mock.module('@/lib/cleanup', () => ({
  clearLocalData: mock(() => Promise.resolve()),
}))

import PreferencesSettingsPage from './preferences'

const anonSession = {
  user: { id: 'anon-1', email: '', name: '', isAnonymous: true },
  session: { id: 's1', userId: 'anon-1', expiresAt: new Date() },
}

const authedSession = {
  user: { id: 'user-1', email: 'a@b.com', name: 'Alice', isAnonymous: false },
  session: { id: 's2', userId: 'user-1', expiresAt: new Date() },
}

describe('PreferencesSettingsPage — sync toggle gating', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows hint text and no sync toggle for anonymous users', () => {
    const authClient = createMockAuthClient({ session: anonSession as never })
    render(<PreferencesSettingsPage />, { wrapper: createTestProvider({ authClient }) })

    expect(screen.getByText('Sign in to enable sync across devices.')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /sync this device/i })).not.toBeInTheDocument()
  })

  it('shows sync toggle and no hint for authenticated (non-anonymous) users', () => {
    const authClient = createMockAuthClient({ session: authedSession as never })
    render(<PreferencesSettingsPage />, { wrapper: createTestProvider({ authClient }) })

    expect(screen.queryByText('Sign in to enable sync across devices.')).not.toBeInTheDocument()
    // The sync toggle row should be present — the label is rendered
    expect(screen.getByText('Sync This Device With Cloud')).toBeInTheDocument()
  })

  it('shows Delete All Local Data for anonymous users (R-23)', () => {
    const authClient = createMockAuthClient({ session: anonSession as never })
    render(<PreferencesSettingsPage />, { wrapper: createTestProvider({ authClient }) })

    expect(screen.getByText('Delete All Local Data')).toBeInTheDocument()
  })

  it('shows Delete My Account for anonymous users (R-23)', () => {
    const authClient = createMockAuthClient({ session: anonSession as never })
    render(<PreferencesSettingsPage />, { wrapper: createTestProvider({ authClient }) })

    expect(screen.getByText('Delete My Account')).toBeInTheDocument()
  })
})
