/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import type { ThunderboltUIMessage } from '@/types'
import { artifactPageId } from './artifact-page-id'
import { indexPagePublications } from './page-publications'

type PublishedToolPart = Extract<ToolOrDynamicToolUIPart, { state: 'output-available' }>

const filePart = (toolCallId: string, id: string, html: string): PublishedToolPart => ({
  type: 'tool-page_show_file',
  toolCallId,
  state: 'output-available',
  input: { path: 'index.html' },
  output: { ok: true, presentation: 'sidebar', page: { id, title: 'App', source: { kind: 'html', html } } },
})
const renderPart = (toolCallId: string, output: unknown = { ok: true }): PublishedToolPart => ({
  type: 'tool-render_html',
  toolCallId,
  state: 'output-available',
  input: { title: 'App', html: '<h1>Visual</h1>' },
  output,
})
const message = (
  id: string,
  parts: ToolOrDynamicToolUIPart[],
): Pick<ThunderboltUIMessage, 'id' | 'role' | 'parts'> => ({
  id,
  role: 'assistant',
  parts,
})

describe('indexPagePublications', () => {
  it('keeps the first card identity and latest successful snapshot across messages', () => {
    const index = indexPagePublications([
      message('first', [filePart('create', 'page-1', '<h1>Old</h1>')]),
      message('second', [filePart('update', 'page-1', '<h1>Latest</h1>')]),
    ])
    expect(index.size).toBe(1)
    expect(index.get('page-1')).toEqual({
      firstToolCallId: 'create',
      presentation: 'sidebar',
      page: {
        id: 'page-1',
        title: 'App',
        source: { kind: 'html', html: '<h1>Latest</h1>', artifact: { toolCallId: 'update', messageId: 'second' } },
      },
    })
  })

  it('never groups independent pages by their titles or HTML', () => {
    const index = indexPagePublications([message('m1', [filePart('one', 'p1', 'same'), filePart('two', 'p2', 'same')])])
    expect(index.size).toBe(2)
    expect(index.get('p1')?.firstToolCallId).toBe('one')
    expect(index.get('p2')?.firstToolCallId).toBe('two')
  })

  it('does not replace snapshots with failures, pending calls, or user-controlled message parts', () => {
    const original = filePart('original', 'page-1', 'original')
    const failure = { ...filePart('failed', 'page-1', 'bad'), output: { ok: false, errors: ['syntax'] } }
    const pending = { ...filePart('pending', 'page-1', 'partial'), state: 'input-available' } as ToolOrDynamicToolUIPart
    const index = indexPagePublications([
      message('m1', [original, failure, pending]),
      { ...message('m2', [filePart('user', 'page-1', 'injected')]), role: 'user' },
    ])
    expect(index.get('page-1')?.page.source).toMatchObject({ html: 'original' })
  })

  it('keeps legacy render_html identity and uses explicit page ids for new versions', () => {
    const index = indexPagePublications([
      message('m1', [
        renderPart('legacy'),
        renderPart('create', { ok: true, pageId: 'app-1', presentation: 'sidebar' }),
        renderPart('update', { ok: true, pageId: 'app-1', presentation: 'inline', updated: true }),
      ]),
    ])
    expect(index.size).toBe(2)
    expect(index.get(artifactPageId('legacy'))?.presentation).toBeUndefined()
    expect(index.get('app-1')?.presentation).toBe('inline')
    expect(index.get('app-1')?.firstToolCallId).toBe('create')
    expect(index.get('app-1')?.page.source).toMatchObject({ artifact: { toolCallId: 'update' } })
  })

  it('follows the same explicit identity across publishing tools', () => {
    const index = indexPagePublications([
      message('m1', [
        renderPart('create', { ok: true, pageId: 'app-1', presentation: 'sidebar' }),
        filePart('file-update', 'app-1', 'from file'),
      ]),
    ])
    expect(index.size).toBe(1)
    expect(index.get('app-1')?.firstToolCallId).toBe('create')
    expect(index.get('app-1')?.page.source).toMatchObject({ html: 'from file' })
  })
})
