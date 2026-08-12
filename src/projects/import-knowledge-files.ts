/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Import pipeline for project knowledge: extract text, enforce a per-document
 * ceiling, and report what didn't make it.
 *
 * A multi-file selection routinely contains files with no text form (images,
 * binaries). Those are *counted and named* in the result rather than dropped
 * quietly, because "I selected 20 files and got 4" needs an explanation in the UI.
 */

import { v7 as uuidv7 } from 'uuid'

import { canExtractKnowledgeText, extractKnowledgeText } from './extract-knowledge-text'

/** Per-document ceiling. A single huge file would otherwise evict every other
 *  document from the prompt budget on its own. */
export const maxKnowledgeChars = 200_000

export type ImportedDocument = {
  filename: string
  sourceMimeType: string
  content: string
}

export type ImportResult = {
  documents: ImportedDocument[]
  /** Files skipped because the type has no text form, with a sample of names. */
  skipped: string[]
  /** Files that matched but failed to parse. */
  failed: string[]
  /** Documents truncated at {@link maxKnowledgeChars}. */
  truncated: string[]
}

/**
 * Extract every importable file in the list. Order is preserved so the prompt
 * budget consumes documents in the order the user sees them.
 */
export const importKnowledgeFiles = async (files: readonly File[]): Promise<ImportResult> => {
  const result: ImportResult = { documents: [], skipped: [], failed: [], truncated: [] }

  for (const file of files) {
    const path = file.name
    if (!canExtractKnowledgeText(file.type, file.name)) {
      result.skipped.push(path)
      continue
    }
    try {
      const text = await extractKnowledgeText({
        id: uuidv7(),
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        createdAt: 0,
        blob: file,
      })
      const trimmed = text.trim()
      if (trimmed.length === 0) {
        result.failed.push(path)
        continue
      }
      if (trimmed.length > maxKnowledgeChars) {
        result.truncated.push(path)
      }
      result.documents.push({
        filename: path,
        sourceMimeType: file.type,
        content: trimmed.slice(0, maxKnowledgeChars),
      })
    } catch {
      result.failed.push(path)
    }
  }

  return result
}

/** One-line, human summary of what an import did. Null when everything landed. */
export const summarizeImport = (result: ImportResult): string | null => {
  const notes: string[] = []
  if (result.skipped.length > 0) {
    notes.push(`${result.skipped.length} unsupported ${result.skipped.length === 1 ? 'file' : 'files'} skipped`)
  }
  if (result.failed.length > 0) {
    notes.push(`${result.failed.length} could not be read`)
  }
  if (result.truncated.length > 0) {
    notes.push(`${result.truncated.length} truncated`)
  }
  if (notes.length === 0) {
    return null
  }
  const added = result.documents.length
  return `Added ${added} ${added === 1 ? 'document' : 'documents'} — ${notes.join(', ')}.`
}
