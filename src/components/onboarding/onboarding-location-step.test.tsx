/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { OnboardingLocationStep } from './onboarding-location-step'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)

const response = [{ id: 123, name: 'Zero', region: 'Region', country: 'Country', countryCode: 'ZZ', lat: 0, lon: 0 }]
const chooseLocation = async () => {
  fireEvent.change(screen.getByPlaceholderText('Search locations…'), { target: { value: 'Zero' } })
  await act(async () => {
    await getClock().tickAsync(300)
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('option', { name: 'Zero, Region, Country' }))
  })
}

describe('OnboardingLocationStep', () => {
  it('saves a typed picker selection including zero coordinates exactly once', async () => {
    const submitLocation = mock(async () => {})
    render(
      <OnboardingLocationStep
        state={{ locationValue: '', isSubmittingLocation: false }}
        actions={{ submitLocation }}
      />,
      {
        wrapper: createTestProvider({ mockResponse: response }),
      },
    )
    expect(screen.getAllByRole('combobox')[0]).toHaveAccessibleName('Location')
    await chooseLocation()
    expect(submitLocation).toHaveBeenCalledTimes(1)
    expect(submitLocation).toHaveBeenCalledWith({
      locationName: 'Zero, Region, Country',
      locationId: 123,
      locationLat: 0,
      locationLng: 0,
      locationCountryCode: 'ZZ',
    })
  })

  it('shows a retained selection on revisit and prevents replacement during persistence', () => {
    const submitLocation = mock(async () => {})
    render(
      <OnboardingLocationStep
        state={{ locationValue: 'Paris', isSubmittingLocation: true }}
        actions={{ submitLocation }}
      />,
      {
        wrapper: createTestProvider(),
      },
    )
    expect(screen.getByRole('combobox', { name: 'Location' })).toHaveTextContent('Paris')
    expect(screen.getByRole('combobox', { name: 'Location' })).toBeDisabled()
    expect(screen.queryByPlaceholderText('Search locations…')).toBeNull()
    expect(submitLocation).not.toHaveBeenCalled()
  })

  it('handles a rejected save at the event boundary without an unhandled rejection', async () => {
    const submitLocation = mock(async () => {
      throw new Error('disk full')
    })
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(
        <OnboardingLocationStep
          state={{ locationValue: '', isSubmittingLocation: false }}
          actions={{ submitLocation }}
        />,
        {
          wrapper: createTestProvider({ mockResponse: response }),
        },
      )
      await chooseLocation()
      expect(log).toHaveBeenCalledWith('Failed to save location:', expect.any(Error))
    } finally {
      log.mockRestore()
    }
  })
})
