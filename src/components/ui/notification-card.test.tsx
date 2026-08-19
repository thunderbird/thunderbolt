/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { getClock } from '@/testing-library'
import { NotificationCard } from './notification-card'

afterEach(cleanup)

describe('NotificationCard', () => {
  it('composes its icon, message, details, actions, and dismiss control', () => {
    const onDismiss = mock()
    render(
      <NotificationCard
        open
        icon={<span data-testid="notification-icon" />}
        message="Update ready"
        details={<p>Version 2.0</p>}
        actions={<button>Restart</button>}
        onDismiss={onDismiss}
      />,
    )

    expect(screen.getByTestId('notification-icon')).toBeInTheDocument()
    expect(screen.getByText('Update ready')).toBeInTheDocument()
    expect(screen.getByText('Version 2.0')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does not render card content while closed', () => {
    render(<NotificationCard open={false} icon={<span />} message="Hidden message" onDismiss={() => {}} />)

    expect(screen.queryByText('Hidden message')).toBeNull()
  })

  it('never dismisses itself', async () => {
    const onDismiss = mock()
    render(<NotificationCard open icon={<span />} message="Persistent message" onDismiss={onDismiss} />)

    await act(async () => {
      await getClock().tickAsync(30_000)
    })

    expect(onDismiss).not.toHaveBeenCalled()
  })
})
