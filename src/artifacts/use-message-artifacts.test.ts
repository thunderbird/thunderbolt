/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { Database } from '@/db/database'
import { applySchema } from '@/db/apply-schema'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'
import { artifactMessagesQuery } from './use-message-artifacts'
import { messageArtifacts } from './library'

const database = new Database()
beforeEach(async () => {
  await database.initialize({ type: 'bun-sqlite', path: ':memory:' })
  await applySchema(database.db)
})
afterEach(async () => {
  await database.close()
})

it('finds saved artifacts in loose, project and connected-agent chats while excluding soft-deleted records', async () => {
  const db = database.db
  const threadIds = [uuidv7(), uuidv7(), uuidv7(), uuidv7()]
  await db.insert(chatThreadsTable).values([
    { id: threadIds[0], title: 'Loose' },
    { id: threadIds[1], title: 'Project', projectId: 'project' },
    { id: threadIds[2], title: 'Remote', agentId: 'connected-agent', acpSessionId: 'session' },
    { id: threadIds[3], title: 'Deleted chat', deletedAt: '2026-10-23T00:00:00Z' },
  ])
  const part = {
    type: 'tool-render_html' as const,
    toolCallId: 'tool',
    state: 'output-available' as const,
    input: { html: '<h1>Saved</h1>', title: 'Report' },
    output: { ok: true },
  }
  await db
    .insert(chatMessagesTable)
    .values(threadIds.map((chatThreadId) => ({ id: uuidv7(), chatThreadId, parts: [part] })))
  await db.insert(chatMessagesTable).values([
    { id: uuidv7(), chatThreadId: threadIds[0], parts: [part], deletedAt: '2026-10-23T00:00:00Z' },
    { id: uuidv7(), chatThreadId: threadIds[0], parts: [{ type: 'text', text: 'ordinary' }] },
  ])
  const artifacts = messageArtifacts(await artifactMessagesQuery(db))
  expect(artifacts.map((artifact) => artifact.chatTitle).sort()).toEqual(['Loose', 'Project', 'Remote'])
})
