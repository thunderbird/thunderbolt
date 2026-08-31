/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { MiniAppOriginNotice } from './mini-app-chat-banner'
import type { MiniAppDefinition } from './registry'

afterEach(cleanup)

const app = {
  id: 'patient-journeys',
  name: 'Patient Journeys',
  url: 'https://apps.example.com/journeys',
  icon: () => null,
} as unknown as MiniAppDefinition

const renderNotice = (value: MiniAppDefinition | null) =>
  render(
    <MemoryRouter>
      <MiniAppOriginNotice app={value} chatThreadId="thread-1" />
    </MemoryRouter>,
  )

describe('MiniAppOriginNotice', () => {
  it('names the app the chat came from', () => {
    renderNotice(app)
    expect(screen.getByText('Started from Patient Journeys')).toBeTruthy()
  })

  /**
   * The link is the point: it returns to the app *with this chat already open*,
   * rather than dumping the user on a fresh session of it.
   */
  it('links back to the app carrying this chat', () => {
    renderNotice(app)
    const link = screen.getByText('Open app') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/apps/patient-journeys?chat=thread-1')
  })

  /**
   * Guards the whole reason `mini_app_id` isn't a foreign key: the registry is
   * deployment config, so an app can vanish between releases and its chats have
   * to keep opening.
   */
  it('says so plainly when the app is no longer registered', () => {
    renderNotice(null)
    expect(screen.getByText('Started from an app that is no longer available')).toBeTruthy()
  })

  it('offers no way back to an app that is gone', () => {
    renderNotice(null)
    expect(screen.queryByText('Open app')).toBeNull()
  })
})
