/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { describe, expect, it } from 'bun:test'
import { xlsxMime } from '@/files/transformers'
import type { StoredFile } from '@/lib/file-blob-storage'
import type { ThunderboltUIMessage } from '@/types'
import { prepareBuiltInConversation, type BuiltInConversationDeps } from './built-in-conversation'

const storedFile = (id: string, mimeType: string): StoredFile => ({
  id,
  filename: id,
  mimeType,
  size: 1,
  createdAt: 0,
  blob: new Blob([id], { type: mimeType }),
})

const inline = { workspace: false }
const workspace = { workspace: true }

const message = (role: 'user' | 'assistant', parts: ThunderboltUIMessage['parts']): ThunderboltUIMessage => ({
  id: crypto.randomUUID(),
  role,
  parts,
})

describe('prepareBuiltInConversation', () => {
  it('flattens quotes/text attachments and maps current images to Pi image content', async () => {
    const files = new Map([
      ['notes', storedFile('notes', 'text/plain')],
      ['diagram', storedFile('diagram', 'image/png')],
    ])
    const deps: BuiltInConversationDeps = {
      getAttachment: async (id) => files.get(id) ?? null,
      getTransformer: async (mimeType, target) =>
        mimeType === 'text/plain' && target === 'text' ? async () => ({ text: 'note contents' }) : null,
      blobToBase64: async () => 'aW1hZ2U=',
      readXlsxSheets: async () => [],
    }
    const messages = [
      message('user', [
        { type: 'text', text: 'Review this' },
        {
          type: 'data-attachment',
          data: { localFileId: 'notes', filename: 'notes.txt', mimeType: 'text/plain' },
        },
      ]),
      message('assistant', [{ type: 'text', text: 'Reviewed.' }]),
      message('user', [
        { type: 'data-quote', data: { text: 'first line\nsecond line' } },
        { type: 'text', text: 'What changed?' },
        {
          type: 'data-attachment',
          data: { localFileId: 'diagram', filename: 'diagram.png', mimeType: 'image/png' },
        },
      ]),
    ]

    const prepared = await prepareBuiltInConversation(messages, ['Follow project style.'], inline, deps)

    expect(prepared.history).toEqual([
      { role: 'user', text: 'Review this\n[Attachment: notes.txt]\n\nnote contents' },
      { role: 'assistant', text: 'Reviewed.' },
    ])
    expect(prepared.prompt.text).toBe(
      'Follow project style.\n\n> first line\n> second line\nWhat changed?\n[Attachment: diagram.png]',
    )
    expect(prepared.prompt.images).toEqual([{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }])
  })

  it('extracts native binary documents when Pi cannot send their raw file shape', async () => {
    const deps: BuiltInConversationDeps = {
      getAttachment: async () => storedFile('report', 'application/pdf'),
      getTransformer: async (_mimeType, target) => (target === 'text' ? async () => ({ text: 'PDF contents' }) : null),
      blobToBase64: async () => '',
      readXlsxSheets: async () => [],
    }
    const messages = [
      message('user', [
        {
          type: 'data-attachment',
          data: { localFileId: 'report', filename: 'report.pdf', mimeType: 'application/pdf' },
        },
        { type: 'text', text: 'Summarize it.' },
      ]),
    ]

    const prepared = await prepareBuiltInConversation(messages, undefined, inline, deps)

    expect(prepared.prompt.text).toBe('[Attachment: report.pdf]\n\nPDF contents\nSummarize it.')
    expect(prepared.prompt.images).toEqual([])
  })

  it('keeps an explicit marker when attachment bytes are unavailable', async () => {
    const deps: BuiltInConversationDeps = {
      getAttachment: async () => null,
      getTransformer: async () => null,
      blobToBase64: async () => '',
      readXlsxSheets: async () => [],
    }
    const messages = [
      message('user', [
        {
          type: 'data-attachment',
          data: { localFileId: 'missing', filename: 'missing.bin', mimeType: 'application/octet-stream' },
        },
      ]),
    ]

    const prepared = await prepareBuiltInConversation(messages, undefined, inline, deps)

    expect(prepared.prompt.text).toBe('[Attachment: missing.bin] (file unavailable on this device)')
  })

  describe('with a workspace', () => {
    const textFile = (id: string, filename: string, mimeType: string, text: string): StoredFile => ({
      id,
      filename,
      mimeType,
      size: text.length,
      createdAt: 0,
      blob: new Blob([text], { type: mimeType }),
    })

    const depsFor = (
      files: StoredFile[],
      overrides: Partial<BuiltInConversationDeps> = {},
    ): BuiltInConversationDeps => ({
      getAttachment: async (id) => files.find((file) => file.id === id) ?? null,
      getTransformer: async (_mimeType, target) =>
        target === 'text' ? async (file: StoredFile) => ({ text: await file.blob.text() }) : null,
      blobToBase64: async () => '',
      readXlsxSheets: async () => [],
      ...overrides,
    })

    const attachment = (file: StoredFile): ThunderboltUIMessage['parts'][number] => ({
      type: 'data-attachment',
      data: { localFileId: file.id, filename: file.filename, mimeType: file.mimeType },
    })

    it('shows a short file whole after the path it was saved to', async () => {
      const file = textFile('n1', 'notes.md', 'text/markdown', '# Notes\nship it')

      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file), { type: 'text', text: 'Summarize' }])],
        undefined,
        workspace,
        depsFor([file]),
      )

      expect(prepared.prompt.text).toBe(
        '[Attachment: notes.md — saved as attachments/n1/notes.md]\n\n# Notes\nship it\nSummarize',
      )
      expect(prepared.files).toEqual([{ path: 'attachments/n1/notes.md', content: '# Notes\nship it' }])
    })

    it('converts a CSV to TSV, keeping quoted commas in one column', async () => {
      const file = textFile('c1', 'spend.csv', 'text/csv', '"payee","amount"\n"Hertz, LLC","-99.5"\n')

      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file)])],
        undefined,
        workspace,
        depsFor([file]),
      )

      expect(prepared.files).toEqual([
        { path: 'attachments/c1/spend.tsv', content: 'payee\tamount\nHertz, LLC\t-99.5\n' },
      ])
      expect(prepared.prompt.text).toBe(
        '[Attachment: spend.csv — saved as attachments/c1/spend.tsv]\n\npayee\tamount\nHertz, LLC\t-99.5',
      )
    })

    it('recognizes a CSV by extension when its MIME type was normalized to text/plain', async () => {
      const file = textFile('c2', 'export.CSV', 'text/plain', 'a,b\n1,2')

      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file)])],
        undefined,
        workspace,
        depsFor([file]),
      )

      expect(prepared.files).toEqual([{ path: 'attachments/c2/export.tsv', content: 'a\tb\n1\t2\n' }])
    })

    it.each([
      ['semicolon-delimited', 'eu.csv', 'a;b\n1,5;2,25'],
      ['malformed', 'odd.csv', 'a,b\n"open,1\n2,3'],
    ])('keeps a %s CSV as its original text', async (_what, filename, text) => {
      const file = textFile('k1', filename, 'text/csv', text)

      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file)])],
        undefined,
        workspace,
        depsFor([file]),
      )

      expect(prepared.files).toEqual([{ path: `attachments/k1/${filename}`, content: text }])
      expect(prepared.prompt.text).toBe(`[Attachment: ${filename} — saved as attachments/k1/${filename}]\n\n${text}`)
    })

    it('truncates a long file to a preview with a marker pointing at the full file', async () => {
      const rows = Array.from({ length: 1000 }, (_, index) => `${index},${index * 2}`)
      const file = textFile('big', 'big.csv', 'text/csv', ['n,double', ...rows].join('\n'))

      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file)])],
        undefined,
        workspace,
        depsFor([file]),
      )

      const lines = prepared.prompt.text.split('\n')
      expect(lines[0]).toBe('[Attachment: big.csv — saved as attachments/big/big.tsv]')
      expect(lines).toContain('198\t396')
      expect(lines).not.toContain('199\t398')
      expect(lines.at(-1)).toBe(
        '[Showing lines 1-200 of 1001. Compute over the full file with bash instead of answering from this preview. If the full file cannot be read, say so rather than answering from the preview.]',
      )
      expect(prepared.files[0].content.endsWith('\n')).toBe(true)
      expect(prepared.files[0].content.trimEnd().split('\n')).toHaveLength(1001)
    })

    const promptFor = async (text: string) => {
      const file = textFile('t1', 'notes.txt', 'text/plain', text)
      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file)])],
        undefined,
        workspace,
        depsFor([file]),
      )
      return prepared.prompt.text
    }

    it.each([
      ['a single line of exactly 16000 characters', 'x'.repeat(16_000)],
      ['lines that land exactly on the character budget', `${'x'.repeat(7_999)}\n${'y'.repeat(8_000)}`],
      ['exactly 200 lines', Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')],
    ])('keeps %s whole', async (_what, text) => {
      expect(await promptFor(text)).toBe(`[Attachment: notes.txt — saved as attachments/t1/notes.txt]\n\n${text}`)
    })

    it('cuts by characters after the last line that fits', async () => {
      const text = ['short', 'x'.repeat(10_000), 'y'.repeat(10_000)].join('\n')

      const prompt = await promptFor(text)

      expect(prompt).toContain('x'.repeat(10_000))
      expect(prompt).not.toContain('yyy')
      expect(prompt).toContain('[Showing lines 1-2 of 3.')
    })

    it('labels an empty file without a workspace copy', async () => {
      const file = textFile('e1', 'empty.csv', 'text/csv', '')

      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file)])],
        undefined,
        workspace,
        depsFor([file]),
      )

      expect(prepared.prompt.text).toBe('[Attachment: empty.csv]')
      expect(prepared.files).toEqual([])
    })

    it('cuts a single oversized line by characters', async () => {
      const file = textFile('j1', 'blob.json', 'application/json', `${'x'.repeat(20_000)}\nnext`)

      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file)])],
        undefined,
        workspace,
        depsFor([file]),
      )

      expect(prepared.prompt.text).toContain('[Showing the first 16000 of 20005 characters.')
      expect(prepared.prompt.text).not.toContain('next')
    })

    it('writes each spreadsheet sheet as its own TSV', async () => {
      const file = textFile('x1', 'budget.xlsx', xlsxMime, '## Sheet: Q1\nName, Cost\nRent, 10')
      const readXlsxSheets = async () => [
        {
          name: 'Q1',
          rows: [
            ['Name', 'Cost'],
            ['Rent', '10'],
          ],
        },
        { name: 'Q2/Q3', rows: [['Name'], ['Tab\there']] },
      ]

      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file)])],
        undefined,
        workspace,
        depsFor([file], { readXlsxSheets }),
      )

      expect(prepared.files).toEqual([
        { path: 'attachments/x1/Q1.tsv', content: 'Name\tCost\nRent\t10\n' },
        { path: 'attachments/x1/Q2_Q3.tsv', content: 'Name\nTab here\n' },
      ])
      expect(prepared.prompt.text).toBe(
        [
          '[Attachment: budget.xlsx — saved as attachments/x1/Q1.tsv, attachments/x1/Q2_Q3.tsv]',
          '',
          '## Sheet: Q1',
          'Name\tCost',
          'Rent\t10',
          '## Sheet: Q2/Q3',
          'Name',
          'Tab here',
        ].join('\n'),
      )
    })

    it('keeps every sheet when sheet names clean up to the same file name', async () => {
      const file = textFile('x2', 'sales.xlsx', xlsxMime, '')
      const readXlsxSheets = async () => ['Sales$', 'Sales€', 'Sales_'].map((name) => ({ name, rows: [[name]] }))

      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file)])],
        undefined,
        workspace,
        depsFor([file], { readXlsxSheets }),
      )

      expect(prepared.files.map((entry) => entry.path)).toEqual([
        'attachments/x2/Sales_.tsv',
        'attachments/x2/Sales_ (2).tsv',
        'attachments/x2/Sales_ (3).tsv',
      ])
    })

    it('saves extracted document text as a .txt file', async () => {
      const file = textFile('p1', 'report.pdf', 'application/pdf', 'PDF contents')

      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file)])],
        undefined,
        workspace,
        depsFor([file]),
      )

      expect(prepared.files).toEqual([{ path: 'attachments/p1/report.pdf.txt', content: 'PDF contents' }])
    })

    it('keeps an unsafe filename inside its attachment directory', async () => {
      const file = textFile('u1', '../../etc/pass*wd.txt', 'text/plain', 'x')

      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file)])],
        undefined,
        workspace,
        depsFor([file]),
      )

      expect(prepared.files.map((entry) => entry.path)).toEqual(['attachments/u1/.._.._etc_pass_wd.txt'])
    })

    it('keeps a readable name, collapsing each run of unsafe characters', async () => {
      const file = textFile('u2', 'my spend: 2026/Q1 ✈️.csv', 'text/csv', 'a,b\n1,2')

      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file)])],
        undefined,
        workspace,
        depsFor([file]),
      )

      expect(prepared.files.map((entry) => entry.path)).toEqual(['attachments/u2/my spend_ 2026_Q1 _.tsv'])
    })

    it.each(['..', '.'])('falls back to a generic name for %p', async (filename) => {
      const file = textFile('u3', filename, 'text/plain', 'x')

      const prepared = await prepareBuiltInConversation(
        [message('user', [attachment(file)])],
        undefined,
        workspace,
        depsFor([file]),
      )

      expect(prepared.files.map((entry) => entry.path)).toEqual(['attachments/u3/file'])
    })

    it('uses the same shape for history turns and writes each attachment once', async () => {
      const file = textFile('h1', 'spend.csv', 'text/csv', 'a,b\n1,2')
      const messages = [
        message('user', [attachment(file), { type: 'text', text: 'Total?' }]),
        message('assistant', [{ type: 'text', text: '3' }]),
        message('user', [attachment(file), { type: 'text', text: 'Again?' }]),
      ]

      const prepared = await prepareBuiltInConversation(messages, undefined, workspace, depsFor([file]))

      expect(prepared.history[0]).toEqual({
        role: 'user',
        text: '[Attachment: spend.csv — saved as attachments/h1/spend.tsv]\n\na\tb\n1\t2\nTotal?',
      })
      expect(prepared.files).toEqual([{ path: 'attachments/h1/spend.tsv', content: 'a\tb\n1\t2\n' }])
    })

    it('leaves images and unavailable files unchanged', async () => {
      const image = textFile('i1', 'chart.png', 'image/png', 'png')
      const prepared = await prepareBuiltInConversation(
        [
          message('user', [
            attachment(image),
            { type: 'data-attachment', data: { localFileId: 'gone', filename: 'gone.csv', mimeType: 'text/csv' } },
          ]),
        ],
        undefined,
        workspace,
        depsFor([image], { blobToBase64: async () => 'cG5n' }),
      )

      expect(prepared.prompt.text).toBe(
        '[Attachment: chart.png]\n[Attachment: gone.csv] (file unavailable on this device)',
      )
      expect(prepared.prompt.images).toEqual([{ type: 'image', mimeType: 'image/png', data: 'cG5n' }])
      expect(prepared.files).toEqual([])
    })
  })
})
