/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
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
})
