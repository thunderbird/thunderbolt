/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { unitDefaultsForRegion } from '@/i18n/region-units'
import { updateSettings } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getClock } from '@/testing-library'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { type ReactNode } from 'react'

// Per docs/development/testing.md: do NOT mock shared modules. All app-internal hooks
// (useSettings, useSyncEnabledToggle, etc.) use their real implementations and run
// against the test DB / mock HTTP client provided by createTestProvider.
// `posthog-js` is already globally mocked by src/testing-library.ts.

import { SignInModalProvider } from '@/contexts'
import type { AuthClient } from '@/contexts'
import PreferencesSettingsPage, { initialPreferencesState, preferencesReducer } from './preferences'

const anonSession = {
  user: { id: 'anon-1', email: '', name: '', isAnonymous: true },
}

const authedSession = {
  user: { id: 'user-1', email: 'a@b.com', name: 'Alice', isAnonymous: false },
}

const renderPage = (authClient: AuthClient) => {
  const TestProvider = createTestProvider({ authClient })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TestProvider>
      <SignInModalProvider>{children}</SignInModalProvider>
    </TestProvider>
  )
  return render(<PreferencesSettingsPage />, { wrapper: Wrapper })
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

  it('shows Sign In button and no sync toggle for anonymous users', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderPage(authClient)

    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /sync this device/i })).not.toBeInTheDocument()
  })

  it('shows sync toggle and no Sign In button for authenticated (non-anonymous) users', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient)

    expect(screen.queryByRole('button', { name: 'Sign In' })).toBeNull()
    expect(screen.getByText('Sync This Device With Cloud')).toBeInTheDocument()
  })

  it('shows the cloud proxy setting in Network immediately above Data', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient)

    const sectionTitles = screen.getAllByRole('heading').map((heading) => heading.textContent)
    const networkIndex = sectionTitles.indexOf('Network')

    expect(screen.getByRole('switch', { name: 'Use Cloud Proxy' })).toBeInTheDocument()
    expect(sectionTitles[networkIndex + 1]).toBe('Data')
  })

  it('shows Delete All Local Data for anonymous users (R-23)', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderPage(authClient)

    expect(screen.getByText('Delete All Local Data')).toBeInTheDocument()
  })

  it('hides Delete My Account for anonymous users (no real account exists to delete)', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderPage(authClient)

    expect(screen.queryByText('Delete My Account')).toBeNull()
  })

  it('shows Delete My Account for authenticated (non-anonymous) users', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient)

    expect(screen.getByText('Delete My Account')).toBeInTheDocument()
  })
})

describe('PreferencesSettingsPage — Localization layout', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(() => {
    cleanup()
  })

  it('orders the Localization section Location → Language → Distance', () => {
    renderPage(createMockAuthClient({ session: authedSession }))

    const [location, language, distance] = ['Location', 'Language', 'Distance'].map((label) => screen.getByText(label))

    expect(location.compareDocumentPosition(language) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(language.compareDocumentPosition(distance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('offers no Date Format row', () => {
    renderPage(createMockAuthClient({ session: authedSession }))

    expect(screen.queryByText('Date Format')).toBeNull()
  })

  it('labels the stored units through Intl rather than a fetched catalogue', async () => {
    // These strings used to arrive as English from a backend JSON, so they never
    // passed through a catalogue at all. Names come from the catalogue now and
    // symbols from CLDR.
    await updateSettings(getDb(), { distance_unit: 'metric', temperature_unit: 'c', time_format: '24h' })

    renderPage(createMockAuthClient({ session: authedSession }))
    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByLabelText('Distance unit')).toHaveTextContent('Metric (km)')
    expect(screen.getByLabelText('Temperature unit')).toHaveTextContent('Celsius (°C)')
    // A rendered example, not the stored '24h' token.
    expect(screen.getByLabelText('Time format')).toHaveTextContent('13:30')
  })
})

describe('preferencesReducer — location-driven suggestions', () => {
  const countryUnits = unitDefaultsForRegion('DE')

  it('defers the language prompt until the units prompt is answered', () => {
    const suggested = preferencesReducer(initialPreferencesState, {
      type: 'SUGGEST_LOCATION_DEFAULTS',
      payload: { countryUnits, language: 'de' },
    })

    expect(suggested.localizationDialogOpen).toBe(true)
    expect(suggested.languageDialogOpen).toBe(false)

    const afterUnits = preferencesReducer(suggested, { type: 'CLOSE_LOCALIZATION_DIALOG' })

    expect(afterUnits.localizationDialogOpen).toBe(false)
    expect(afterUnits.languageDialogOpen).toBe(true)
    expect(afterUnits.pendingLanguage).toBe('de')
  })

  it('prompts for the language immediately when there are no units to suggest', () => {
    const suggested = preferencesReducer(initialPreferencesState, {
      type: 'SUGGEST_LOCATION_DEFAULTS',
      payload: { countryUnits: null, language: 'ja' },
    })

    expect(suggested.languageDialogOpen).toBe(true)
  })

  it('does not chain a language prompt when the location suggests none', () => {
    const suggested = preferencesReducer(initialPreferencesState, {
      type: 'SUGGEST_LOCATION_DEFAULTS',
      payload: { countryUnits, language: null },
    })

    expect(preferencesReducer(suggested, { type: 'CLOSE_LOCALIZATION_DIALOG' }).languageDialogOpen).toBe(false)
  })
})
