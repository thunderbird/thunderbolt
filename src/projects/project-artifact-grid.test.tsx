/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act, fireEvent, render } from '@testing-library/react'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { DatabaseProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { mockVirtuaMeasurement } from '@/test-utils/mock-virtua-measurement'
import { mockIntersectionObserver } from '@/test-utils/mock-intersection-observer'
import { ProjectArtifactGrid } from './project-artifact-grid'
import { artifactGridColumns, artifactGridHeight } from './use-project-artifact-grid-state'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)

it('caps the viewport at three complete rows and adapts columns to available width', () => {
  expect(artifactGridHeight(0, 258)).toBe(0)
  expect(artifactGridHeight(1, 258)).toBe(258)
  expect(artifactGridHeight(2, 258)).toBe(532)
  expect(artifactGridHeight(3, 258)).toBe(806)
  expect(artifactGridHeight(1000, 258)).toBe(806)
  expect(artifactGridColumns(300)).toBe(1)
  expect(artifactGridColumns(535)).toBe(1)
  expect(artifactGridColumns(536)).toBe(2)
  expect(artifactGridColumns(992)).toBe(3)
})

it('keeps a large collection bounded while scrolling to the last partial row', async () => {
  const restoreSize = mockVirtuaMeasurement({
    measure: (target) => ({
      width: 992,
      height: target.matches('[data-slot="artifact-grid-scroll"]') ? 806 : target.matches('a') ? 258 : 274,
    }),
  })
  const restoreVisibility = mockIntersectionObserver()
  const artifacts = Array.from({ length: 301 }, (_, index) => ({
    id: `m${index}-0`,
    messageId: `m${index}`,
    toolCallId: `t${index}`,
    chatThreadId: 'c1',
    chatTitle: 'Demo',
    title: `Artifact ${index + 1}`,
    html: '<h1>Preview</h1>',
    createdAt: new Date(),
  }))
  try {
    const { container, getByRole, queryByRole, unmount } = render(
      <DatabaseProvider db={getDb()}>
        <MemoryRouter>
          <ProjectArtifactGrid
            projectId="p1"
            artifacts={artifacts}
            pinnedIds={[]}
            isSaving={false}
            onTogglePin={() => {}}
          />
        </MemoryRouter>
      </DatabaseProvider>,
    )
    await act(async () => {
      await getClock().tickAsync(50)
    })
    const viewport = container.querySelector<HTMLDivElement>('[data-slot="artifact-grid-scroll"]')!
    expect(viewport.style.height).toBe('806px')
    expect(getByRole('link', { name: 'Open Artifact 1' })).toBeTruthy()
    expect(queryByRole('link', { name: 'Open Artifact 301' })).toBeNull()
    expect(container.querySelectorAll('iframe').length).toBeLessThanOrEqual(18)
    expect(container.querySelector('[aria-setsize="301"]')).toBeTruthy()
    fireEvent.scroll(viewport, { target: { scrollTop: 26868 } })
    await act(async () => {
      await getClock().tickAsync(250)
    })
    expect(getByRole('link', { name: 'Open Artifact 301' })).toBeTruthy()
    expect(container.querySelectorAll('iframe').length).toBeLessThanOrEqual(18)
    expect(queryByRole('link', { name: 'Open Artifact 1' })).toBeNull()
    unmount()
  } finally {
    restoreVisibility()
    restoreSize()
  }
})
