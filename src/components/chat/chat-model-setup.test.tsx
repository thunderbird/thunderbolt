/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { CreateItemProvider, useCreateItem } from '@/components/create-item/context'
import { ChatModelSetup } from './chat-model-setup'

const Destination = () => {
  const { request } = useCreateItem()
  const location = useLocation()
  return <output>{request?.kind ?? location.pathname}</output>
}

const renderSetup = () =>
  render(
    <MemoryRouter initialEntries={['/chats/new']}>
      <CreateItemProvider>
        <ChatModelSetup />
        <Destination />
      </CreateItemProvider>
    </MemoryRouter>,
  )

afterEach(cleanup)

it('opens the model aside without navigating away from chat', () => {
  renderSetup()
  fireEvent.click(screen.getByRole('button', { name: 'Add a model' }))
  expect(screen.getByRole('status')).toHaveTextContent('model')
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('opens Connections for provider setup', () => {
  renderSetup()
  fireEvent.click(screen.getByRole('button', { name: 'Connect a provider' }))
  expect(screen.getByRole('status')).toHaveTextContent('/settings/connections')
})
