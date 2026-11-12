/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { UIMessage } from 'ai'
import { docxMime } from '@/files/transformers'
import { threadFileIds } from './thread-files'

const created = (ids: string[]) => ({
  ok: true,
  files: ids.map((id) => ({ id, filename: `${id}.docx`, mimeType: docxMime, edited: false })),
  logs: '',
})

describe('threadFileIds', () => {
  it("lists the user's attachments and the tool's files in thread order, once each", () => {
    const messages: UIMessage[] = [
      {
        id: 'm1',
        role: 'user',
        parts: [
          { type: 'text', text: 'Edit this' },
          { type: 'data-attachment', data: { localFileId: 'upload', filename: 'brief.docx', mimeType: docxMime } },
        ],
      },
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-run_office_script',
            toolCallId: 'c1',
            state: 'output-available',
            input: {},
            output: created(['first', 'upload']),
          },
          // The harness wraps a result in an envelope and may emit it as a dynamic tool.
          {
            type: 'dynamic-tool',
            toolName: 'run_office_script',
            toolCallId: 'c2',
            state: 'output-available',
            input: {},
            output: { content: [], details: created(['second']) },
          },
        ],
      },
    ]

    expect(threadFileIds(messages)).toEqual(['upload', 'first', 'second'])
  })

  it('skips failed runs, runs still going and other tools', () => {
    const messages: UIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-run_office_script',
            toolCallId: 'c1',
            state: 'output-available',
            input: {},
            output: { ok: false, error: 'boom', logs: '' },
          },
          { type: 'tool-run_office_script', toolCallId: 'c2', state: 'input-available', input: {} },
          { type: 'tool-render_html', toolCallId: 'c3', state: 'output-available', input: {}, output: created(['x']) },
        ],
      },
    ]

    expect(threadFileIds(messages)).toEqual([])
  })
})
