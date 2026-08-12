/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { canExtractKnowledgeText, extractKnowledgeText, resolveKnowledgeMimeType } from './extract-knowledge-text'

const storedFile = (filename: string, content: string, mimeType: string) => ({
  id: 'f1',
  filename,
  mimeType,
  size: content.length,
  createdAt: 0,
  blob: new Blob([content], { type: mimeType }),
})

describe('resolveKnowledgeMimeType', () => {
  it('trusts a declared type we can already handle', () => {
    expect(resolveKnowledgeMimeType('a.pdf', 'application/pdf')).toBe('application/pdf')
    expect(resolveKnowledgeMimeType('a.csv', 'text/csv')).toBe('text/csv')
  })

  it.each([
    ['notes.md', ''],
    ['config.yaml', ''],
    ['script.py', ''],
    ['schema.sql', ''],
    // `.ts` is commonly reported as a video MIME by the OS.
    ['module.ts', 'video/mp2t'],
  ])('falls back to text for %s declared as "%s"', (filename, declared) => {
    expect(resolveKnowledgeMimeType(filename, declared)).toBe('text/plain')
  })

  it('leaves a genuinely unusable type alone', () => {
    expect(resolveKnowledgeMimeType('photo.png', 'image/png')).toBe('image/png')
    expect(resolveKnowledgeMimeType('archive.zip', '')).toBe('')
  })

  it('handles a file with no extension at all', () => {
    expect(resolveKnowledgeMimeType('Makefile', '')).toBe('')
  })
})

describe('canExtractKnowledgeText', () => {
  it('accepts documents and text, including OS-mislabelled files', () => {
    expect(canExtractKnowledgeText('application/pdf', 'a.pdf')).toBe(true)
    expect(canExtractKnowledgeText('', 'notes.md')).toBe(true)
    expect(canExtractKnowledgeText('video/mp2t', 'module.ts')).toBe(true)
  })

  it('rejects formats with no text form', () => {
    expect(canExtractKnowledgeText('image/png', 'photo.png')).toBe(false)
    expect(canExtractKnowledgeText('', 'archive.zip')).toBe(false)
  })
})

describe('extractKnowledgeText', () => {
  it('reads a plain-text file through the passthrough transformer', async () => {
    expect(await extractKnowledgeText(storedFile('notes.txt', 'hello world', 'text/plain'))).toContain('hello world')
  })

  it('reads a file the OS mislabelled, via extension fallback', async () => {
    expect(await extractKnowledgeText(storedFile('notes.md', '# Title', ''))).toContain('# Title')
  })

  it('throws for a type with no text form, rather than storing empty knowledge', async () => {
    await expect(extractKnowledgeText(storedFile('photo.png', 'binary', 'image/png'))).rejects.toThrow(
      /can’t be added as project knowledge/,
    )
  })
})
