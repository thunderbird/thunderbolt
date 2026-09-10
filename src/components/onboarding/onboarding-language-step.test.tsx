/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettingsRecords } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getActiveLocale, setActiveLocale } from '@/i18n/active-locale'
import { getClock } from '@/testing-library'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { OnboardingLanguageStep } from './onboarding-language-step'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('OnboardingLanguageStep', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  afterEach(() => {
    cleanup()
    setActiveLocale('en')
    localStorage.removeItem('thunderbolt_locale')
  })

  const renderStep = () => render(<OnboardingLanguageStep />, { wrapper: createTestProvider() })

  it('renders the language prompt', () => {
    renderStep()

    expect(screen.getByText('Which language do you prefer?')).toBeInTheDocument()
  })

  it('exposes a labelled language picker', () => {
    renderStep()

    expect(screen.getByRole('combobox', { name: 'Language' })).toBeInTheDocument()
  })

  /**
   * Selecting an option goes through `useLanguageSetting`: the locale publishes
   * synchronously in the click handler (so the CRUD upload the write queues
   * already carries the new `X-App-Language`), then persists as an explicit
   * edit that later seeding must not overwrite.
   */
  it('publishes, mirrors and persists a picked language', async () => {
    renderStep()

    const trigger = screen.getByRole('combobox', { name: 'Language' })
    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
    fireEvent.click(trigger)
    const option = screen.getByRole('option', { name: '日本語' })
    fireEvent.pointerUp(option, { button: 0, pointerId: 1 })
    fireEvent.click(option)

    expect(getActiveLocale()).toBe('ja')
    expect(localStorage.getItem('thunderbolt_locale')).toBe('ja')

    await act(async () => {
      await getClock().runAllAsync()
    })
    const [record] = await getSettingsRecords(getDb(), ['language'])
    expect(record?.value).toBe('ja')
  })
})
