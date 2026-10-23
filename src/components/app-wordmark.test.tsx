/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { AppWordmark } from './app-wordmark'

describe('AppWordmark', () => {
  afterEach(() => {
    useConfigStore.setState({ config: {} })
  })

  it('names the app once, leaving the logo out of the accessible name', () => {
    render(<AppWordmark />)

    expect(screen.getByText('Thunderbolt')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Thunderbolt' })).not.toBeInTheDocument()
  })

  it("shows the operator's app name", () => {
    useConfigStore.setState({ config: { branding: { appName: 'Acme' } } })
    render(<AppWordmark />)

    expect(screen.getByText('Acme')).toBeInTheDocument()
  })
})
