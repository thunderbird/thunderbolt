/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, fireEvent, render } from '@testing-library/react'
import { afterAll, beforeAll, expect, it, mock } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { ProjectArtifactActionsProvider } from './project-artifact-actions-provider'
import { ProjectArtifactCard } from './project-artifact-card'
import { DatabaseProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { mockIntersectionObserver } from '@/test-utils/mock-intersection-observer'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)

it('previews offline without scripts or focus, and keeps pinning separate from navigation', async () => {
  const restore = mockIntersectionObserver()
  const onTogglePin = mock(() => {})
  const { container, getByRole, queryByRole } = render(
    <DatabaseProvider db={getDb()}>
      <MemoryRouter>
        <ProjectArtifactActionsProvider>
          <ProjectArtifactCard
            projectId="p1"
            artifact={{
              id: 'm1-0',
              messageId: 'm1',
              toolCallId: 't1',
              chatThreadId: 'c1',
              chatTitle: 'Demo',
              title: 'Chart',
              html: '<h1>Chart</h1><script>throw new Error()</script>',
              createdAt: new Date(),
            }}
            pinned={false}
            isSaving={false}
            onTogglePin={onTogglePin}
          />
        </ProjectArtifactActionsProvider>
      </MemoryRouter>
    </DatabaseProvider>,
  )
  await act(async () => {})
  restore()
  const frame = container.querySelector('iframe')!
  expect(frame.getAttribute('sandbox')).toBe('')
  expect(frame.getAttribute('tabindex')).toBe('-1')
  expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy')
  expect(getByRole('link', { name: 'Open Chart' }).getAttribute('href')).toBe('/projects/p1/artifacts/m1-0')
  expect(container.querySelector('button')).toBeNull()
  fireEvent.contextMenu(getByRole('link', { name: 'Open Chart' }), { clientX: 100, clientY: 100 })
  const pin = getByRole('menuitem', { name: 'Pin to project' })
  expect(pin.closest('a')).toBeNull()
  expect(getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
  expect(getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
  expect(queryByRole('menuitem', { name: 'Copy HTML' })).toBeNull()
  expect(getByRole('menuitem', { name: 'Download HTML' })).toBeTruthy()
  expect(getByRole('menuitem', { name: 'Open source chat' })).toBeTruthy()
  fireEvent.click(pin)
  expect(onTogglePin).toHaveBeenCalledTimes(1)
})
