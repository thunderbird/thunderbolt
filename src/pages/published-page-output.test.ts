/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { PageDefinition } from '@shared/page-protocol'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { groupMessageParts } from '@/lib/assistant-message'
import { publishedPageOutput } from './published-page-output'

const page: PageDefinition = { id: 'page-1', title: 'Example', source: { kind: 'url', url: 'https://example.com' } }
const part = (name: string, output: unknown, input: unknown = {}): ToolOrDynamicToolUIPart => ({
  type: 'dynamic-tool',
  toolName: name,
  toolCallId: 'call-1',
  state: 'output-available',
  input,
  output,
})

describe('publishedPageOutput', () => {
  it('accepts typed AI objects and Pi details/text envelopes without requiring text-only content', () => {
    for (const output of [
      { ok: true, page, sessionId: 'session-1' },
      { details: { ok: true, page }, content: [{ type: 'image', data: 'ignored' }] },
      {
        content: [
          { type: 'image', data: 'ignored' },
          { type: 'text', text: JSON.stringify({ ok: true, page }) },
        ],
      },
    ]) {
      expect(publishedPageOutput(part('page_open', output))?.page).toEqual(page)
    }
  })

  it('only lifts successful publishing operations, leaving status/list/failures in the tool group', () => {
    const local: PageDefinition = { id: 'local-app:123', title: 'App', source: { kind: 'local-app', appId: '123' } }
    for (const action of ['create', 'start', 'restart']) {
      expect(publishedPageOutput(part('local_app', { page: local, status: 'ready' }, { action }))?.page).toEqual(local)
    }
    for (const action of ['list', 'status', 'stop']) {
      expect(publishedPageOutput(part('local_app', { page: local, status: 'ready' }, { action }))).toBeNull()
    }
    const candidates = [
      part('unknown_tool', { ok: true, page }),
      part('page_show_file', { ok: true, page }),
      part('page_open', { ok: false, page, details: { ok: true, page } }),
      part('page_open', { isError: true, details: { ok: true, page } }),
      part('page_open', {
        details: { ok: false },
        content: [{ type: 'text', text: JSON.stringify({ ok: true, page }) }],
      }),
      part('local_app', { page: local, status: 'starting' }, { action: 'create' }),
      { ...part('page_open', { ok: true, page }), state: 'input-available' } as ToolOrDynamicToolUIPart,
    ]
    for (const candidate of candidates) {
      expect(publishedPageOutput(candidate)).toBeNull()
      expect(groupMessageParts([candidate])[0]?.type).toBe('reasoning_group')
    }
  })

  it('rejects privileged URLs, credentials, invalid ids, and oversized UTF-8 HTML', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///tmp/a',
      'data:text/html,hi',
      'https://user:secret@example.com',
      'https://example.com/\n',
    ]) {
      expect(
        publishedPageOutput(part('page_open', { ok: true, page: { ...page, source: { kind: 'url', url } } })),
      ).toBeNull()
    }
    expect(publishedPageOutput(part('page_open', { ok: true, page: { ...page, id: '../escape' } }))).toBeNull()
    expect(
      publishedPageOutput(
        part('page_show_file', { ok: true, page: { ...page, source: { kind: 'html', html: '😀'.repeat(600_000) } } }),
      ),
    ).toBeNull()
    expect(publishedPageOutput(part('page_open', { content: [{ type: 'text', text: '{bad JSON' }] }))).toBeNull()
  })

  it('lifts a completed dynamic page result between reasoning groups', () => {
    const published = part('page_open', { ok: true, page })
    const ordinary = part('page_snapshot', { text: 'Example' })
    const grouped = groupMessageParts([ordinary, published, ordinary])
    expect(grouped.map((item) => item.type)).toEqual(['reasoning_group', 'dynamic-tool', 'reasoning_group'])
    expect(grouped[1]).toBe(published)
  })
})
