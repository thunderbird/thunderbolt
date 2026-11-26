/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { UIMessage } from 'ai'
import { docxMime } from '@/files/transformers'
import { threadFileRefs } from './thread-files'

const created = (ids: string[], size = 10) => ({
  ok: true,
  files: ids.map((id) => ({
    id,
    filename: `${id}.docx`,
    mimeType: docxMime,
    size,
    edited: false,
    savedAs: `${id}.docx`,
  })),
  logs: '',
})

describe('threadFileRefs', () => {
  it("lists the user's attachments and the tool's files in thread order, once each, with the tool's saved names and sizes", () => {
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
            output: created(['first', 'upload'], 40),
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
      { id: 'notes', filename: 'notes.docx' },
      { id: 'upload', filename: 'upload.docx', savedAs: 'upload.docx', size: 40 },
      { id: 'first', filename: 'first.docx', savedAs: 'first.docx', size: 40 },
      { id: 'second', filename: 'second.docx', savedAs: 'second.docx', size: 10 },
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
          // A result missing a field every result carries.
          {
            type: 'tool-run_office_script',
            toolCallId: 'c4',
            state: 'output-available',
            input: {},
            output: { ok: true, files: [{ id: 'y', filename: 'y.docx', mimeType: docxMime }], logs: '' },
          },
        ],
      },
    ]

    expect(threadFileRefs(messages)).toEqual([])
  })
})
