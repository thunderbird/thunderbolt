/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable, projectFilesTable, projectsTable } from '@/db/tables'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createProject, getProjectFiles } from '@/dal/projects'
import type { AttachmentData } from '@/types'
import {
  absorbChatAttachments,
  absorbExistingChatAttachments,
  attachmentsToAbsorb,
  type AbsorbDeps,
} from './absorb-chat-attachments'

/**
 * Stands in for the device-local IndexedDB store, injected as a dependency.
 *
 * Deliberately NOT `mock.module('@/lib/file-blob-storage')`: bun installs module
 * mocks worker-wide, so stubbing a module imported by ~15 files leaks into every
 * test that runs after this one.
 */
const blobs = new Map<string, { filename: string; mimeType: string; content: string }>()

const fakeBlobStore: AbsorbDeps = {
  getAttachment: async (id: string) => {
    const stored = blobs.get(id)
    if (!stored) {
      return null
    }
    return {
      id,
      filename: stored.filename,
      mimeType: stored.mimeType,
      size: stored.content.length,
      createdAt: 0,
      blob: new Blob([stored.content], { type: stored.mimeType }),
    }
  },
}

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  const db = getDb()
  await db.delete(projectFilesTable)
  await db.delete(projectsTable)
  await db.delete(chatMessagesTable)
  await db.delete(chatThreadsTable)
  blobs.clear()
})

afterEach(() => {
  blobs.clear()
})

/** Register a device-local blob and return the reference a message would carry. */
const attach = (filename: string, content: string, mimeType = 'text/plain'): AttachmentData => {
  const localFileId = `local-${filename}-${content.length}`
  blobs.set(localFileId, { filename, mimeType, content })
  return { localFileId, filename, mimeType }
}

describe('absorbChatAttachments', () => {
  it('adds a chat attachment to the project as chat-origin knowledge', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })

    const result = await absorbChatAttachments(
      db,
      project.id,
      [attach('policy.md', 'No refunds.', 'text/markdown')],
      fakeBlobStore,
    )

    expect(result.added).toEqual(['policy.md'])
    const [saved] = await getProjectFiles(db, project.id)
    expect(saved.filename).toBe('policy.md')
    expect(saved.content).toBe('No refunds.')
    // Distinguishes it from a typed note or an assistant-written one in the UI.
    expect(saved.origin).toBe('chat')
  })

  it('is idempotent — re-sending the same file adds one document', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const attachment = attach('policy.md', 'No refunds.', 'text/markdown')

    await absorbChatAttachments(db, project.id, [attachment], fakeBlobStore)
    const second = await absorbChatAttachments(db, project.id, [attachment], fakeBlobStore)

    expect(second.added).toEqual([])
    expect(second.duplicates).toEqual(['policy.md'])
    expect(await getProjectFiles(db, project.id)).toHaveLength(1)
  })

  it('adds a new version when the same filename has different content', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })

    await absorbChatAttachments(db, project.id, [attach('policy.md', 'v1', 'text/markdown')], fakeBlobStore)
    await absorbChatAttachments(db, project.id, [attach('policy.md', 'v2 revised', 'text/markdown')], fakeBlobStore)

    // Keeping only the stale copy would be the worse failure.
    const contents = (await getProjectFiles(db, project.id)).map((file) => file.content)
    expect(contents).toEqual(['v1', 'v2 revised'])
  })

  it('reports an image as unsupported and stores nothing', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })

    const result = await absorbChatAttachments(
      db,
      project.id,
      [attach('photo.png', 'binary', 'image/png')],
      fakeBlobStore,
    )

    expect(result.unsupported).toEqual(['photo.png'])
    expect(await getProjectFiles(db, project.id)).toEqual([])
  })

  it('absorbs a file the OS mislabelled', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const result = await absorbChatAttachments(db, project.id, [attach('config.yaml', 'key: value', '')], fakeBlobStore)
    expect(result.added).toEqual(['config.yaml'])
  })

  it('skips quietly when the bytes are on another device', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    // A synced message references a blob this device never stored.
    const foreign: AttachmentData = { localFileId: 'not-here', filename: 'remote.md', mimeType: 'text/markdown' }

    const result = await absorbChatAttachments(db, project.id, [foreign], fakeBlobStore)

    expect(result).toEqual({ added: [], duplicates: [], unsupported: [] })
    expect(await getProjectFiles(db, project.id)).toEqual([])
  })

  it('does nothing for a message with no attachments', async () => {
    const project = await createProject(getDb(), { name: 'P' })
    expect(await absorbChatAttachments(getDb(), project.id, [], fakeBlobStore)).toEqual({
      added: [],
      duplicates: [],
      unsupported: [],
    })
  })

  it('handles several attachments in one message', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })

    const result = await absorbChatAttachments(
      db,
      project.id,
      [attach('a.md', 'first', 'text/markdown'), attach('b.txt', 'second'), attach('c.png', 'binary', 'image/png')],
      fakeBlobStore,
    )

    expect(result.added).toEqual(['a.md', 'b.txt'])
    expect(result.unsupported).toEqual(['c.png'])
  })
})

describe('attachmentsToAbsorb', () => {
  const userWith = (...attachments: AttachmentData[]) => ({
    role: 'user',
    parts: attachments.map((data) => ({ type: 'data-attachment' as const, data })),
  })
  const assistant = { role: 'assistant', parts: [{ type: 'text' as const, text: 'ok' }] }

  it('takes the newest user turn only', () => {
    const old = attach('old.md', 'old')
    const fresh = attach('fresh.md', 'fresh')
    // The send-time save carries the whole conversation; re-extracting `old.md`
    // on every later turn would parse the same file once per message.
    const result = attachmentsToAbsorb([userWith(old), assistant, userWith(fresh)])
    expect(result.map((a) => a.filename)).toEqual(['fresh.md'])
  })

  it('ignores assistant messages after the user turn', () => {
    const file = attach('a.md', 'a')
    expect(attachmentsToAbsorb([userWith(file), assistant]).map((a) => a.filename)).toEqual(['a.md'])
  })

  it('returns nothing for an assistant-only save', () => {
    expect(attachmentsToAbsorb([assistant])).toEqual([])
  })

  it('returns nothing when the newest user turn has no attachments', () => {
    expect(attachmentsToAbsorb([userWith(attach('a.md', 'a')), assistant, userWith()])).toEqual([])
  })

  it('returns every attachment on that one turn', () => {
    const result = attachmentsToAbsorb([userWith(attach('a.md', 'a'), attach('b.md', 'b'))])
    expect(result.map((a) => a.filename)).toEqual(['a.md', 'b.md'])
  })

  it('handles an empty save', () => {
    expect(attachmentsToAbsorb([])).toEqual([])
  })
})

describe('absorbExistingChatAttachments (chat moved into a project)', () => {
  /** Insert a chat with messages the way the app persists them. */
  const seedChat = async (attachments: AttachmentData[][]) => {
    const db = getDb()
    const threadId = uuidv7()
    await db.insert(chatThreadsTable).values({ id: threadId, title: 'T', projectId: null })
    for (const group of attachments) {
      await db.insert(chatMessagesTable).values({
        id: uuidv7(),
        chatThreadId: threadId,
        role: 'user',
        content: 'here you go',
        parts: group.map((data) => ({ type: 'data-attachment', data })) as never,
      })
    }
    return threadId
  }

  it('back-fills a file attached before the chat joined the project', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const threadId = await seedChat([[attach('cabin.md', 'The site is at 8,400 feet.', 'text/markdown')]])

    // The reported bug: upload, ask, *then* add the chat to the project.
    const result = await absorbExistingChatAttachments(db, project.id, threadId, fakeBlobStore)

    expect(result.added).toEqual(['cabin.md'])
    const [saved] = await getProjectFiles(db, project.id)
    expect(saved.filename).toBe('cabin.md')
    expect(saved.origin).toBe('chat')
  })

  it('walks the whole history, not just the newest turn', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const threadId = await seedChat([
      [attach('first.md', 'one', 'text/markdown')],
      [attach('second.md', 'two', 'text/markdown')],
    ])

    const result = await absorbExistingChatAttachments(db, project.id, threadId, fakeBlobStore)

    // The save path deliberately looks at one turn; back-fill must not.
    expect(result.added).toEqual(['first.md', 'second.md'])
  })

  it('is safe to run twice (e.g. moved out and back)', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const threadId = await seedChat([[attach('a.md', 'body', 'text/markdown')]])

    await absorbExistingChatAttachments(db, project.id, threadId, fakeBlobStore)
    const second = await absorbExistingChatAttachments(db, project.id, threadId, fakeBlobStore)

    expect(second.duplicates).toEqual(['a.md'])
    expect(await getProjectFiles(db, project.id)).toHaveLength(1)
  })

  it('does nothing for a chat with no attachments', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const threadId = await seedChat([[]])
    expect(await absorbExistingChatAttachments(db, project.id, threadId, fakeBlobStore)).toEqual({
      added: [],
      duplicates: [],
      unsupported: [],
    })
  })
})
