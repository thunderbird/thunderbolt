/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { trayCommandEvent, type TrayCommand } from '@/lib/tray'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { useTrayCommands } from './use-tray-commands'

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/chats/existing']}>{children}</MemoryRouter>
)

const render = () =>
  renderHook(
    () => {
      useTrayCommands()
      return useLocation()
    },
    { wrapper },
  )

const fire = (command: TrayCommand) =>
  act(() => {
    window.dispatchEvent(new CustomEvent<TrayCommand>(trayCommandEvent, { detail: command }))
  })

describe('useTrayCommands', () => {
  it('starts a new chat the way the sidebar button does', () => {
    const { result } = render()

    fire('new-chat')

    expect(result.current.pathname).toBe('/chats/new')
    expect(result.current.state).toEqual({ focusComposer: true, newChatRequestId: expect.any(String) })
  })

  it('opens settings on its first page, since /settings alone is blank', () => {
    const { result } = render()

    fire('settings')

    expect(result.current.pathname).toBe('/settings/preferences')
  })

  it('stops listening on unmount', () => {
    const { result, unmount } = render()
    const before = result.current.pathname

    unmount()
    fire('settings')

    expect(result.current.pathname).toBe(before)
  })
})
