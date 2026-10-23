/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, spyOn } from 'bun:test'
import { Dialog, DialogTitle } from '@/components/ui/dialog'
import { ResponsiveModalContentComposable } from '@/components/ui/responsive-modal'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { getClock } from '@/testing-library'
import { getDb } from '@/db/database'
import { settingsTable } from '@/db/tables'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { ProjectArtifactActionsProvider, useProjectArtifactActions } from './project-artifact-actions-provider'
import { artifactPresentationKeys } from './artifact-presentation'
import type { ProjectArtifact } from './project-artifacts-data'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(() => {
  cleanup()
  restoreViewport()
})
const artifact: ProjectArtifact = {
  id: 'action-test-0',
  messageId: 'action-test',
  toolCallId: 'call',
  chatThreadId: 'chat',
  chatTitle: 'Source',
  title: 'Chart',
  html: '<p>Chart</p>',
  createdAt: new Date(),
}
const Trigger = () => {
  const actions = useProjectArtifactActions()
  return <button onClick={() => actions.openDialog(artifact, 'rename')}>Rename card</button>
}
const Fixture = ({ version }: { version: number }) => (
  <ProjectArtifactActionsProvider>
    <Trigger key={version} />
  </ProjectArtifactActionsProvider>
)
it('keeps the rename draft when its virtual card remounts and persists the new title', async () => {
  const view = render(<Fixture version={1} />, { wrapper: createTestProvider() })
  fireEvent.click(screen.getByRole('button', { name: 'Rename card' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Artifact name' }), { target: { value: 'Draft survives' } })
  view.rerender(<Fixture version={2} />)
  expect(screen.getByRole('textbox', { name: 'Artifact name' })).toHaveValue('Draft survives')
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  const settings = await getDb().select().from(settingsTable)
  expect(settings.find((row) => row.key === artifactPresentationKeys(artifact.id).title)?.value).toBe('Draft survives')
})
it('keeps a failed rename open and allows retry', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {})
  const write = spyOn(getDb(), 'transaction').mockRejectedValueOnce(new Error('write failed'))
  try {
    render(<Fixture version={1} />, { wrapper: createTestProvider() })
    fireEvent.click(screen.getByRole('button', { name: 'Rename card' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Artifact name' }), { target: { value: 'Retry title' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not rename')
    expect(screen.getByRole('textbox', { name: 'Artifact name' })).toHaveValue('Retry title')
    write.mockRestore()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  } finally {
    write.mockRestore()
    log.mockRestore()
  }
})

it('keeps mobile artifact actions within the gallery focus boundary and saves a rename', async () => {
  forceMobileViewport()
  render(
    <Dialog open>
      <ResponsiveModalContentComposable aria-describedby={undefined}>
        <DialogTitle>Artifacts</DialogTitle>
        <Fixture version={1} />
      </ResponsiveModalContentComposable>
    </Dialog>,
    { wrapper: createTestProvider() },
  )
  const gallery = screen.getByRole('dialog', { name: 'Artifacts' })
  fireEvent.click(screen.getByRole('button', { name: 'Rename card' }))
  const rename = screen.getByRole('dialog', { name: 'Rename artifact' })
  expect(gallery).toContainElement(rename)
  await act(async () => {
    await getClock().tickAsync(500)
  })
  const input = screen.getByRole('textbox', { name: 'Artifact name' })
  act(() => input.focus())
  await act(async () => {
    await getClock().tickAsync(20)
  })
  expect(input).toHaveFocus()
  fireEvent.change(input, { target: { value: 'Mobile rename' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })
  const records = await getDb().select().from(settingsTable)
  expect(records.find((row) => row.key === artifactPresentationKeys(artifact.id).title)?.value).toBe('Mobile rename')
})
