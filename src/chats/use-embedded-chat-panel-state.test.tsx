/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'bun:test'
import type { PropsWithChildren } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { useEmbeddedChatPanelState } from './use-embedded-chat-panel-state'

afterEach(cleanup)

const wrapper = ({ children }: PropsWithChildren) => (
  <MemoryRouter initialEntries={['/projects/research?view=recent']}>{children}</MemoryRouter>
)

it('keeps the same project chat mounted when the first send gives it a saved URL', () => {
  const { result } = renderHook(() => ({ panel: useEmbeddedChatPanelState(), location: useLocation() }), { wrapper })
  act(() => result.current.panel.startNewChat())
  const id = result.current.panel.openChatId!
  expect(result.current.location.search).toBe('?view=recent')
  act(() => result.current.panel.handleChatCreated(id))
  expect(result.current.panel.openChatId).toBe(id)
  expect(result.current.panel.draftChatId).toBeNull()
  expect(result.current.location.pathname).toBe('/projects/research')
  expect(new URLSearchParams(result.current.location.search).get('chat')).toBe(id)
  act(() => result.current.panel.closeChat())
  expect(result.current.location.search).toBe('?view=recent')
  act(() => result.current.panel.openExistingChat(id))
  expect(result.current.panel.draftChatId).toBeNull()
  expect(result.current.panel.openChatId).toBe(id)
})
