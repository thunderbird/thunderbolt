/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import type { StoredFile } from '@/lib/file-blob-storage'
import { type ReadWorkspaceFile, resolveInputs } from './script-inputs'

const file = (id: string, filename: string, createdAt: number, text = id): StoredFile => ({
  id,
  filename,
  mimeType: 'application/octet-stream',
  size: text.length,
  createdAt,
  blob: new Blob([text]),
})

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

const missing: ReadWorkspaceFile = async () => ({ status: 'missing' })

describe('resolveInputs', () => {
  const files = [file('old', 'notes.docx', 1), file('new', 'notes.docx', 2), file('deck', 'deck.pptx', 3)]

  it('gives each name the newest file under it and each id its own file', async () => {
    const result = await resolveInputs(['notes.docx', 'old', 'deck.pptx'], files, undefined, 1024)

    expect(result.ok).toBe(true)
    const inputs = result.ok ? result.inputs : []
    expect(inputs.map(({ name, bytes }) => [name, textOf(bytes)])).toEqual([
      ['notes.docx', 'new'],
      ['old', 'old'],
      ['deck.pptx', 'deck'],
    ])
    expect(result.ok && result.filenames).toEqual(['notes.docx', 'notes.docx', 'deck.pptx'])
  })

  it('gives a name the later file in the thread when two were stored at the same moment', async () => {
    const tied = [file('first', 'notes.docx', 5), file('second', 'notes.docx', 5)]

    const result = await resolveInputs(['notes.docx'], tied, undefined, 1024)

    expect(result.ok && result.inputs.map(({ bytes }) => textOf(bytes))).toEqual(['second'])
  })

  it('gives a name the newer copy the tool saved under it, though the tool cleaned the name it stored', async () => {
    const stored = [
      file('attached', 'Q1  REPORT.DOCX', 1),
      { ...file('edited', 'Q1 REPORT.docx', 2), savedAs: 'Q1  REPORT.DOCX' },
      file('colon', 'a:b.docx', 3),
      file('upload', 'a b.docx', 4),
      { ...file('other edit', 'a b.docx', 5), savedAs: 'a b.docx' },
    ]

    const result = await resolveInputs(['Q1  REPORT.DOCX', 'a:b.docx'], stored, undefined, 1024)

    expect(result.ok && result.inputs.map(({ bytes }) => textOf(bytes))).toEqual(['edited', 'colon'])
  })

  it('reads the workspace only for a name no stored file has', async () => {
    const asked: string[] = []
    const readWorkspaceFile: ReadWorkspaceFile = async (path) => {
      asked.push(path)
      return { status: 'read', bytes: new TextEncoder().encode(`workspace ${path}`) }
    }

    const result = await resolveInputs(['deck.pptx', 'out/data.json'], files, readWorkspaceFile, 1024)

    expect(asked).toEqual(['out/data.json'])
    expect(result.ok && result.inputs.map(({ bytes }) => textOf(bytes))).toEqual(['deck', 'workspace out/data.json'])
    expect(result.ok && result.filenames).toEqual(['deck.pptx', 'data.json'])
  })

  it('names the files it can read when one is missing, and the workspace only when there is one', async () => {
    const listed =
      'The files in this chat, newest first: "deck.pptx" (id deck), "notes.docx" (id new), "notes.docx" (id old).'

    expect(await resolveInputs(['missing.docx'], files, undefined, 1024)).toEqual({
      ok: false,
      error: `No file "missing.docx" in this chat. ${listed} Name an input by its file name or its id.`,
    })
    expect(await resolveInputs(['missing.docx'], files, missing, 1024)).toEqual({
      ok: false,
      error: `No file "missing.docx" in this chat or in your workspace. ${listed} Name an input by its file name, its id, or its path in your workspace.`,
    })
    expect(await resolveInputs(['missing.docx'], [], undefined, 1024)).toMatchObject({
      error: expect.stringContaining('This chat has no files.'),
    })
  })

  it('refuses a stored file that would go past the limit without reading it', async () => {
    const big = [file('a', 'a.docx', 1, 'x'.repeat(6)), file('b', 'b.docx', 2, 'y'.repeat(6))]
    const read = spyOn(big[1].blob, 'arrayBuffer')

    expect(await resolveInputs(['a.docx'], big, undefined, 10)).toMatchObject({ ok: true })
    expect(await resolveInputs(['a.docx', 'b.docx'], big, undefined, 10)).toMatchObject({
      ok: false,
      error: expect.stringContaining('The inputs add up to more than'),
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('gives the workspace only the room the stored inputs left', async () => {
    const limits: number[] = []
    const readWorkspaceFile: ReadWorkspaceFile = async (_, maxBytes) => {
      limits.push(maxBytes)
      return { status: 'too-large' }
    }

    const result = await resolveInputs(['deck.pptx', 'out/big.json'], files, readWorkspaceFile, 10)

    expect(limits).toEqual([10 - 'deck'.length])
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('The inputs add up to more than') })
  })

  it('reads a name given twice once', async () => {
    const result = await resolveInputs(['deck.pptx', 'deck.pptx'], files, undefined, 1024)
    expect(result.ok && result.inputs.map(({ name }) => name)).toEqual(['deck.pptx'])
  })
})
