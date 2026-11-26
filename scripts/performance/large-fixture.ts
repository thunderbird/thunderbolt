/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { importBackup } from '../../e2e/import-backup'
import { positiveInteger } from './options'
import { createHash } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { defaultModelOpus55 } from '../../shared/defaults/models'
import { loginViaEmailCode } from '../../e2e/helpers'

export type LargeFixtureOptions = {
  chats: number
  messagesPerChat: number
  longChats: number
  longMessages: number
}

const epoch = Date.UTC(2026, 10, 2)
export const archiveSearchTerm = 'archivebenchmark'

/** Bound allocation and preserve the ID stride and final-assistant invariant before constructing the backup. */
export const validateLargeFixtureOptions = (options: LargeFixtureOptions): void => {
  for (const [name, count] of Object.entries(options)) {
    positiveInteger(name, count)
  }
  if (options.longMessages % 2 !== 0 || options.longMessages > 10_000 || options.messagesPerChat > 10_000) {
    throw new Error('Long histories must end in an assistant; each history supports at most 10000 messages')
  }
  if (options.chats + options.longChats > 10_000) {
    throw new Error('The fixture supports at most 10000 populated chats')
  }
  if (options.chats * options.messagesPerChat + options.longChats * options.longMessages > 100_000) {
    throw new Error(
      'The browser fixture supports at most 100000 total messages; use perf:search-index for larger SQL-only workloads',
    )
  }
}

/** Stable time-ordered IDs keep fixtures and chronological sidebar ordering reproducible. */
const id = (sequence: number) => {
  const timestamp = (epoch + sequence).toString(16).padStart(12, '0')
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, '0')}`
}

/** Build a large account with a fixed checkpoint route and a bounded set of repeatedly visited histories. */
export const createLargeFixture = (options: LargeFixtureOptions) => {
  validateLargeFixtureOptions(options)
  const regularChats = Array.from({ length: options.chats }, (_, index) => ({
    id: id(index + 1),
    title: `Archive conversation ${(index + 1).toString().padStart(5, '0')}`,
  }))
  const longChats = Array.from({ length: options.longChats }, (_, index) => ({
    id: id(options.chats + index + 1),
    title: `Large session ${(index + 1).toString().padStart(2, '0')}`,
    finalHeading: `Session ${index + 1} answer ${options.longMessages}`,
  }))
  // Empty threads sort by their own ID; keep this checkpoint above every message-backed thread in the recent list.
  const checkpoint = {
    id: id(1_000_000 + (options.chats + options.longChats) * 10_000),
    title: 'Large account checkpoint',
  }
  const messagesFor = (chatThreadId: string, chatIndex: number, count: number, long: boolean) =>
    Array.from({ length: count }, (_, index) => {
      const sequence = 1_000_000 + chatIndex * 10_000 + index
      const text = long
        ? index % 2 === 0
          ? `Discuss session ${chatIndex - options.chats + 1}, topic ${index + 1}: rendering, memory, and interaction latency.`
          : `### Session ${chatIndex - options.chats + 1} answer ${index + 1}\n\n` +
            'Keep **typing**, scrolling, and menus responsive throughout the conversation.\n\n' +
            '- Measure real interactions.\n- Keep completed content stable.\n  - Preserve focus.\n\n' +
            '```typescript\nconst samples = [16, 17, 18]\nconst total = samples.reduce((a, b) => a + b, 0)\n```\n\n' +
            '| Operation | Result |\n| --- | --- |\n| Render | Complete |\n| Save | Complete |'
        : `${archiveSearchTerm} record ${chatIndex + 1}, message ${index + 1}. ` +
          'A small archived conversation about plans, notes, and completed work.'
      return {
        id: id(sequence),
        chatThreadId,
        parentId: index === 0 ? null : id(sequence - 1),
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: text,
        parts: [
          ...(long && index % 8 === 7
            ? [{ type: 'reasoning', text: 'Compare the measured options before drawing a conclusion.', state: 'done' }]
            : []),
          { type: 'text', text },
        ],
        modelId: defaultModelOpus55.id,
        metadata: { modelId: defaultModelOpus55.id },
      }
    })
  const tables = {
    chat_threads: [...regularChats, ...longChats.map(({ id, title }) => ({ id, title })), checkpoint],
    chat_messages: [
      ...regularChats.flatMap((chat, index) => messagesFor(chat.id, index, options.messagesPerChat, false)),
      ...longChats.flatMap((chat, index) => messagesFor(chat.id, options.chats + index, options.longMessages, true)),
    ],
    models: Array.from({ length: 12 }, (_, index) => ({
      ...defaultModelOpus55,
      id: id(900_000_000 + index),
      name: `Large account model ${index + 1}`,
      isSystem: 0,
      defaultHash: null,
    })),
  }
  return {
    tables,
    checkpoint,
    longChats,
    metadata: {
      version: 1,
      ...options,
      totalChats: tables.chat_threads.length,
      totalMessages: tables.chat_messages.length,
      tablesSha256: createHash('sha256').update(JSON.stringify(tables)).digest('hex'),
    },
  }
}

/** Import through the real backup UI with CPU throttling disabled; setup never contributes to interaction samples. */
export const prepareLargeAccount = async (page: Page, options: LargeFixtureOptions) => {
  const email = await loginViaEmailCode(page)
  const fixture = createLargeFixture(options)
  const backup = {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date(epoch).toISOString(),
    user: { id: 'large-account-fixture', email },
    tables: fixture.tables,
  }
  await importBackup(page, backup, 180_000)
  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('dialog', { name: 'Search', exact: true })
  await search.getByRole('combobox').fill(fixture.checkpoint.title)
  await search.locator(`[data-slot="command-item"][data-value*="${fixture.checkpoint.id}"]`).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${fixture.checkpoint.id}$`))
  await expect(page.locator('textarea')).toBeEditable()
  return { checkpoint: fixture.checkpoint, longChats: fixture.longChats, metadata: fixture.metadata }
}
