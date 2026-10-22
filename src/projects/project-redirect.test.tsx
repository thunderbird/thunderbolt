/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'bun:test'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router'
import { useConfigStore } from '@/api/config-store'
import { ProjectRedirect } from './project-redirect'

const Destination = () => {
  const location = useLocation()
  return (
    <output>
      {location.pathname}
      {location.search}
    </output>
  )
}
afterEach(() => {
  cleanup()
  useConfigStore.setState({ config: {}, configLoaded: false })
})
it.each([
  ['/projects', '/chats/new', false],
  ['/projects/research', '/chats/new?projectId=research', false],
  ['/projects/research', '/chats/new', true],
] as const)('preserves project links %s with minimal mode %s', (path, target, minimalMode) => {
  useConfigStore.setState({ config: { minimalMode }, configLoaded: true })
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:projectId?" element={<ProjectRedirect />} />
        <Route path="/chats/new" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  )
  expect(screen.getByRole('status')).toHaveTextContent(target)
})
