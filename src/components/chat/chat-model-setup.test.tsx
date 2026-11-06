/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { ChatModelSetup } from './chat-model-setup'

const Destination = () => {
  const location = useLocation()
  return <output>{JSON.stringify({ pathname: location.pathname, state: location.state })}</output>
}

const renderSetup = () =>
  render(
    <MemoryRouter initialEntries={['/chats/new']}>
      <ChatModelSetup />
      <Destination />
    </MemoryRouter>,
  )

afterEach(cleanup)

it('shows a title and one action without descriptive text', () => {
  renderSetup()
  expect(screen.getByRole('heading', { name: 'Connect your AI' })).toBeVisible()
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Add connection' })).toBeVisible()
  expect(screen.getByRole('region')).not.toHaveAttribute('aria-describedby')
  expect(screen.getByRole('region').querySelector('p')).toBeNull()
})

it('opens the new connection picker in Connections', () => {
  renderSetup()
  fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
  expect(JSON.parse(screen.getByRole('status').textContent ?? '')).toEqual({
    pathname: '/settings/connections',
    state: { addConnection: true },
  })
})
