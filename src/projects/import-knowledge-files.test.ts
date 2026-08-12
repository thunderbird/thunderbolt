/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { importKnowledgeFiles, maxKnowledgeChars, summarizeImport } from './import-knowledge-files'

const pickedFile = (name: string, content: string, type = 'text/plain'): File => new File([content], name, { type })

describe('importKnowledgeFiles', () => {
  it('imports plain text under its filename', async () => {
    const result = await importKnowledgeFiles([pickedFile('policy.md', 'No refunds.', 'text/markdown')])
    expect(result.documents).toHaveLength(1)
    expect(result.documents[0]).toMatchObject({ filename: 'policy.md', content: 'No refunds.' })
  })

  it('reports an unsupported type as skipped', async () => {
    const result = await importKnowledgeFiles([pickedFile('img/logo.png', 'binary', 'image/png')])
    expect(result.documents).toEqual([])
    expect(result.skipped).toEqual(['img/logo.png'])
  })

  it('treats an empty extraction as a failure, not an empty document', async () => {
    const result = await importKnowledgeFiles([pickedFile('blank.txt', '   ', 'text/plain')])
    expect(result.documents).toEqual([])
    expect(result.failed).toEqual(['blank.txt'])
  })

  it('truncates an over-long document and says so', async () => {
    const result = await importKnowledgeFiles([pickedFile('huge.txt', 'x'.repeat(maxKnowledgeChars + 500))])
    expect(result.documents[0].content.length).toBe(maxKnowledgeChars)
    expect(result.truncated).toEqual(['huge.txt'])
  })

  it('preserves input order so the prompt budget is predictable', async () => {
    const result = await importKnowledgeFiles([
      pickedFile('1.txt', 'one'),
      pickedFile('2.txt', 'two'),
      pickedFile('3.txt', 'three'),
    ])
    expect(result.documents.map((doc) => doc.filename)).toEqual(['1.txt', '2.txt', '3.txt'])
  })
})

describe('summarizeImport', () => {
  it('is silent when everything imported cleanly', () => {
    expect(summarizeImport({ documents: [], skipped: [], failed: [], truncated: [] })).toBeNull()
  })

  it('explains a partial import', () => {
    const summary = summarizeImport({
      documents: [{ filename: 'a', sourceMimeType: 'text/plain', content: 'a' }],
      skipped: ['x.png', 'y.png'],
      failed: ['z.pdf'],
      truncated: ['big.txt'],
    })
    expect(summary).toContain('Added 1 document')
    expect(summary).toContain('2 unsupported files skipped')
    expect(summary).toContain('1 could not be read')
    expect(summary).toContain('1 truncated')
  })

  it('singularizes one skipped file', () => {
    const summary = summarizeImport({ documents: [], skipped: ['x.png'], failed: [], truncated: [] })
    expect(summary).toContain('1 unsupported file skipped')
  })
})

describe('MIME resolution for files the OS mislabels', () => {
  // File pickers hand back an empty `type` for most text-ish files, and an
  // actively wrong one for `.ts`. Without extension fallback these all import
  // as "unsupported" — which is most of what people put in a project.
  it.each([
    ['notes.md', ''],
    ['config.yaml', ''],
    ['script.py', ''],
    ['Makefile.toml', ''],
    ['module.ts', 'video/mp2t'],
  ])('imports %s despite a declared type of "%s"', async (name, declaredType) => {
    const result = await importKnowledgeFiles([pickedFile(name, 'hello', declaredType)])
    expect(result.skipped).toEqual([])
    expect(result.documents.map((doc) => doc.filename)).toEqual([name])
  })

  it('still rejects a genuinely non-text file', async () => {
    const result = await importKnowledgeFiles([pickedFile('photo.png', 'binary', 'image/png')])
    expect(result.documents).toEqual([])
    expect(result.skipped).toEqual(['photo.png'])
  })

  it('rejects an unknown extension with no declared type', async () => {
    const result = await importKnowledgeFiles([pickedFile('archive.zip', 'x', '')])
    expect(result.skipped).toEqual(['archive.zip'])
  })

  it('trusts a declared type we can already handle', async () => {
    const result = await importKnowledgeFiles([pickedFile('data.csv', 'a,b', 'text/csv')])
    expect(result.documents).toHaveLength(1)
  })
})
