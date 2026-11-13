/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { UIMessage } from 'ai'
import { docxMime } from '@/files/transformers'
import { threadFileRefs } from './thread-files'

const created = (ids: string[]) => ({
  ok: true,
  files: ids.map((id) => ({ id, filename: `${id}.docx`, mimeType: docxMime, edited: false, savedAs: `${id}.docx` })),
  logs: '',
})

describe('threadFileRefs', () => {
  it("lists the user's attachments and the tool's files in thread order, once each, with the tool's saved names", () => {
    const messages: UIMessage[] = [
      {
        id: 'm1',
        role: 'user',
        parts: [
          { type: 'text', text: 'Edit this' },
          { type: 'data-attachment', data: { localFileId: 'notes', filename: 'notes.docx', mimeType: docxMime } },
          // A file the tool made, attached again.
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

    expect(threadFileRefs(messages)).toEqual([
      { id: 'notes', savedAs: undefined },
      { id: 'upload', savedAs: 'upload.docx' },
      { id: 'first', savedAs: 'first.docx' },
      { id: 'second', savedAs: 'second.docx' },
    ])
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

    expect(threadFileRefs(messages)).toEqual([])
  })
})
