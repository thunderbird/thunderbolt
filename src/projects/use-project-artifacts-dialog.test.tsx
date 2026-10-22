/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'bun:test'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { useProjectArtifactsDialog } from './use-project-artifacts-dialog'

it('opens and closes the gallery without losing the current chat or its query state', () => {
  const { result } = renderHook(() => ({ dialog: useProjectArtifactsDialog(), location: useLocation() }), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={['/projects/p1?chat=c1&filter=hello']}>{children}</MemoryRouter>
    ),
  })

  act(() => result.current.dialog.open('p2'))
  expect(result.current.location.pathname).toBe('/projects/p1')
  expect(result.current.location.search).toBe('?chat=c1&filter=hello&artifacts=p2')
  expect(result.current.dialog.projectId).toBe('p2')

  act(() => result.current.dialog.close())
  expect(result.current.location.pathname).toBe('/projects/p1')
  expect(result.current.location.search).toBe('?chat=c1&filter=hello')
  expect(result.current.dialog.projectId).toBeNull()
})

it('dismisses the gallery when opening an artifact and restores it on browser Back', () => {
  const { result } = renderHook(
    () => ({ dialog: useProjectArtifactsDialog(), navigate: useNavigate(), location: useLocation() }),
    { wrapper: ({ children }) => <MemoryRouter initialEntries={['/chats/c1']}>{children}</MemoryRouter> },
  )

  act(() => result.current.dialog.open('p1'))
  act(() => result.current.navigate('/projects/p1/artifacts/a1'))
  expect(result.current.dialog.projectId).toBeNull()

  act(() => result.current.navigate(-1))
  expect(result.current.location.pathname).toBe('/chats/c1')
  expect(result.current.dialog.projectId).toBe('p1')
})
