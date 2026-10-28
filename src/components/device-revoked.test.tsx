/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { DeviceRevoked } from './device-revoked'

describe('DeviceRevoked', () => {
  let replaceSpy: ReturnType<typeof spyOn>

  beforeAll(async () => {
    await setupTestDatabase()
    replaceSpy = spyOn(window.location, 'replace').mockImplementation(() => undefined)
  })

  afterAll(async () => {
    replaceSpy.mockRestore()
    await teardownTestDatabase()
  })

  beforeEach(() => {
    replaceSpy.mockClear()
  })

  const renderComponent = () =>
    render(<DeviceRevoked />, {
      wrapper: createTestProvider(),
    })

  it('renders heading and description', () => {
    renderComponent()
    expect(screen.getByRole('heading', { name: 'Device access revoked' })).toBeInTheDocument()
    expect(
      screen.getByText('This device was signed out remotely and its local data has been cleared.'),
    ).toBeInTheDocument()
  })

  it('calls window.location.replace("/") when Back to App is clicked', () => {
    renderComponent()
    fireEvent.click(screen.getByRole('button', { name: 'Back to App' }))
    expect(replaceSpy).toHaveBeenCalledWith('/')
  })
})
