/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Converts a dropped file into the text a project stores as knowledge.
 *
 * Reuses the attachment transformers (`src/files/transformers`) rather than
 * introducing a second extraction path, so a PDF added to a project is parsed by
 * exactly the same code as a PDF attached to a message.
 *
 * Text — not bytes — because project knowledge has to sync: attachment blobs are
 * device-local by design (`src/lib/file-blob-storage.ts`), so a binary knowledge
 * base would only work on the machine that uploaded it.
 */

import { getTransformer, hasTransformer } from '@/files/transformers'
import type { StoredFile } from '@/lib/file-blob-storage'

/**
 * Extensions the OS reports with an empty or actively wrong MIME type, mapped to
 * what they really are.
 *
 * This matters more than it sounds. A file picker gives `.md`, `.py`, `.yaml`,
 * `.toml` and most config files an **empty** `type`, and `.ts` is commonly
 * reported as `video/mp2t` — so the very documents people reach for as project
 * knowledge (notes, code, configs) would all be rejected as "unsupported" while
 * a `.txt` sailed through. Chat attachments don't hit this as hard because they
 * fall back to sending bytes natively; knowledge is text-or-nothing, so a wrong
 * MIME here means the file is silently useless.
 */
const textExtensions = new Set([
  'md',
  'markdown',
  'txt',
  'text',
  'log',
  'csv',
  'tsv',
  'rst',
  'org',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'properties',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'swift',
  'php',
  'sh',
  'bash',
  'zsh',
  'fish',
  'sql',
  'graphql',
  'gql',
  'proto',
  'html',
  'htm',
  'xml',
  'css',
  'scss',
  'less',
  'svg',
])

/**
 * The MIME type to treat a file as. Trusts a declared type that we can already
 * handle; otherwise falls back to the extension. Exported for testing because
 * the mapping is the difference between a folder of notes importing and
 * appearing to be "unsupported".
 */
export const resolveKnowledgeMimeType = (filename: string, declaredType: string): string => {
  if (declaredType && hasTransformer(declaredType, 'text')) {
    return declaredType
  }
  const extension = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
  if (textExtensions.has(extension)) {
    return 'text/plain'
  }
  return declaredType
}

/** Raised when a file type has no text transformer (e.g. an image). */
export class UnsupportedKnowledgeFileError extends Error {
  constructor(
    readonly filename: string,
    readonly mimeType: string,
  ) {
    super(`“${filename}” can’t be added as project knowledge — ${mimeType || 'this file type'} has no text form.`)
    this.name = 'UnsupportedKnowledgeFileError'
  }
}

/** Whether this file can become project knowledge, after MIME resolution. */
export const canExtractKnowledgeText = (mimeType: string, filename = ''): boolean =>
  hasTransformer(resolveKnowledgeMimeType(filename, mimeType), 'text')

/**
 * Extract a file's text. Throws {@link UnsupportedKnowledgeFileError} for a type
 * with no text transformer — surfaced to the user at drop time, so nothing is
 * ever silently stored as empty knowledge.
 */
export const extractKnowledgeText = async (file: StoredFile): Promise<string> => {
  const transformer = await getTransformer(resolveKnowledgeMimeType(file.filename, file.mimeType), 'text')
  if (!transformer) {
    throw new UnsupportedKnowledgeFileError(file.filename, file.mimeType)
  }
  const output = await transformer(file)
  if (!('text' in output)) {
    throw new UnsupportedKnowledgeFileError(file.filename, file.mimeType)
  }
  return output.text
}
