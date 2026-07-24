/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { StatusCard } from './status-card'

afterEach(cleanup)

describe('StatusCard', () => {
  it('composes an icon, title, description, and custom body', () => {
    render(
      <StatusCard icon={<span data-testid="icon" />} title="Connected" description="Ready">
        <button>View tools</button>
      </StatusCard>,
    )

    expect(screen.getByTestId('icon')).toBeInTheDocument()
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View tools' })).toBeInTheDocument()
  })
})
