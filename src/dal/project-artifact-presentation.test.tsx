/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable, settingsTable } from '@/db/tables'
import { applyArtifactPresentation, artifactPresentationKeys } from '@/projects/artifact-presentation'
import { collectProjectArtifacts, readArtifactPins } from '@/projects/project-artifacts-data'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getMessage } from './chat-messages'
import {
  maxArtifactTitleLength,
  renameProjectArtifact,
  softDeleteProjectArtifact,
} from './project-artifact-presentation'
import { useProjectArtifactsState } from './projects'
import { setupTestDatabase, teardownTestDatabase } from './test-utils'

const messageId = '01a15fe6-ee73-770a-b8e0-8e5b4d55d747'
const parts = ['First', 'Second'].map((title) => ({
  type: 'tool-render_html' as const,
  toolCallId: title,
  state: 'output-available' as const,
  input: { title, html: `<h1>${title}</h1>` },
  output: { ok: true },
}))
const artifacts = collectProjectArtifacts([{ id: messageId, chatThreadId: 'chat', chatTitle: 'Source chat', parts }], {
  untitledChat: 'Untitled',
  untitledArtifact: 'Untitled',
})
const presented = async () => applyArtifactPresentation(artifacts, await getDb().select().from(settingsTable))

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(cleanup)
beforeEach(async () => {
  const db = getDb()
  await db.delete(settingsTable)
  await db.delete(chatMessagesTable)
  await db.delete(chatThreadsTable)
  await db.insert(chatThreadsTable).values({ id: 'chat', title: 'Source chat', projectId: 'project' })
  await db.insert(chatMessagesTable).values({ id: messageId, chatThreadId: 'chat', role: 'assistant', parts })
})

it('loads legacy project names and tombstones through the live presentation query', async () => {
  await renameProjectArtifact(getDb(), `${messageId}-0`, 'Legacy name')
  await softDeleteProjectArtifact(getDb(), `${messageId}-Second`)
  const { triggerChange } = renderWithReactivity(<Collection />, {
    tables: ['settings', 'chat_messages', 'chat_threads'],
  })
  await waitForElement(() => screen.queryByText('Legacy name'))
  expect(screen.getByTestId('collection').textContent).toBe('Legacy name')
  await act(async () => {
    await renameProjectArtifact(getDb(), artifacts[0].id, 'Canonical name')
    triggerChange(['settings'])
  })
  await waitForElement(() => screen.queryByText('Canonical name'))
  expect(screen.getByTestId('collection').textContent).toBe('Canonical name')
})

it('persists a rename without changing the source output, sibling artifact, or pinned identity', async () => {
  await renameProjectArtifact(getDb(), artifacts[0].id, '  Updated name  ')
  const result = await presented()
  expect(result.map((item) => item.title)).toEqual(['Updated name', 'Second'])
  expect(readArtifactPins(JSON.stringify([artifacts[0].id]), result)).toEqual([artifacts[0].id])
  expect((await getMessage(getDb(), messageId))?.parts).toEqual(parts)
})

it('soft-deletes only the selected entry and removes its pinned shortcut', async () => {
  await renameProjectArtifact(getDb(), artifacts[0].id, 'Renamed')
  await softDeleteProjectArtifact(getDb(), artifacts[0].id)
  const result = await presented()
  expect(result.map((item) => item.id)).toEqual([artifacts[1].id])
  expect(readArtifactPins(JSON.stringify([artifacts[0].id]), result)).toEqual([])
  const stored = new Map((await getDb().select().from(settingsTable)).map((row) => [row.key, row.value]))
  expect(stored.get(artifactPresentationKeys(artifacts[0].id).deletedAt)).toBeTruthy()
  expect(stored.get(artifactPresentationKeys(artifacts[0].id).title)).toBe('Renamed')
  expect((await getMessage(getDb(), messageId))?.parts).toEqual(parts)
  expect(await getDb().select().from(chatThreadsTable)).toHaveLength(1)
})

it('rejects blank names and caps long names at the UI limit', async () => {
  await expect(renameProjectArtifact(getDb(), artifacts[0].id, ' ')).rejects.toThrow('Artifact title is required')
  await renameProjectArtifact(getDb(), artifacts[0].id, 'x'.repeat(maxArtifactTitleLength + 10))
  expect((await presented())[0].title).toHaveLength(maxArtifactTitleLength)
})

const Collection = () => {
  const { artifacts, isLoading } = useProjectArtifactsState('project')
  return (
    <div data-testid="collection">{isLoading ? 'Loading' : artifacts.map((artifact) => artifact.title).join(', ')}</div>
  )
}

it('loads saved names and tombstones, then reacts to rename changes', async () => {
  await renameProjectArtifact(getDb(), artifacts[0].id, 'Renamed')
  await softDeleteProjectArtifact(getDb(), artifacts[1].id)
  const { triggerChange } = renderWithReactivity(<Collection />, {
    tables: ['settings', 'chat_messages', 'chat_threads'],
  })
  await waitForElement(() => screen.queryByText('Renamed'))
  expect(screen.getByTestId('collection').textContent).toBe('Renamed')
  await act(async () => {
    await renameProjectArtifact(getDb(), artifacts[0].id, 'Changed again')
    triggerChange(['settings'])
  })
  await waitForElement(() => screen.queryByText('Changed again'))
  expect(screen.getByTestId('collection').textContent).toBe('Changed again')
})

it('keeps the loaded collection mounted when a new artifact adds presentation keys', async () => {
  const loadingStates: boolean[] = []
  const Probe = () => {
    const { artifacts, isLoading } = useProjectArtifactsState('project')
    loadingStates.push(isLoading)
    return <div>{isLoading ? 'Loading' : artifacts.map((item) => item.title).join(', ')}</div>
  }
  const { triggerChange } = renderWithReactivity(<Probe />, { tables: ['settings', 'chat_messages', 'chat_threads'] })
  await waitForElement(() => screen.queryByText('First, Second'))
  loadingStates.length = 0
  await act(async () => {
    await getDb()
      .insert(chatMessagesTable)
      .values({
        id: '01a15fe6-ee74-770a-b8e0-8e5b4d55d747',
        chatThreadId: 'chat',
        role: 'assistant',
        parts: [{ ...parts[0], toolCallId: 'Third', input: { title: 'Third', html: '<p>Third</p>' } }],
      })
    triggerChange(['chat_messages'])
  })
  await waitForElement(() => screen.queryByText('Third, First, Second'))
  expect(loadingStates.length).toBeGreaterThan(0)
  expect(loadingStates).not.toContain(true)
})
