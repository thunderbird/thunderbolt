/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { docxMime, pptxMime } from '@/files/transformers'
import { putAttachments, type StoredFile } from '@/lib/file-blob-storage'
import { safeFileName } from '@/lib/safe-file-name'
import { parseToolOutput } from '@/lib/tool-output'
import type { ToolConfig } from '@/types'
import { type DynamicToolUIPart, getToolName, isToolOrDynamicToolUIPart, type ToolUIPart, type UIMessage } from 'ai'
import { z } from 'zod'
import { officeScriptToolName, sandboxLimits } from './constants'
import { runInSandboxWorker } from './run-in-worker'
import type { SandboxResult, SavedFile } from './sandbox'

/** A file the tool added to the attachment store, as listed in its result. The chips are built from this list. */
export type CreatedFile = { id: string; filename: string; mimeType: string }

export type OfficeScriptOutput =
  | { ok: true; files: CreatedFile[]; logs: string }
  | { ok: false; error: string; logs: string }

/** A `run_office_script` tool call, whether emitted as a typed `tool-<name>` or a `dynamic-tool` part. */
export type OfficeScriptPart = ToolUIPart | DynamicToolUIPart

export const isOfficeScriptPart = (part: UIMessage['parts'][number]): part is OfficeScriptPart =>
  isToolOrDynamicToolUIPart(part) && getToolName(part) === officeScriptToolName

const createdFilesSchema = z.object({
  ok: z.literal(true),
  files: z.array(z.object({ id: z.string(), filename: z.string(), mimeType: z.string() })),
})

/** The files a finished, successful call created, or `undefined` while it runs and when it failed. */
export const officeScriptFiles = (part: OfficeScriptPart): CreatedFile[] | undefined =>
  parseToolOutput(createdFilesSchema, part)?.files

const fileTypes = [
  { extension: 'docx', mimeType: docxMime },
  { extension: 'pptx', mimeType: pptxMime },
]

// Checked before `safeFileName`, whose trimming backtracks on a long run of dots.
const maxFilenameLength = 200

type DeliverableFile = SavedFile & { mimeType: string }

/**
 * Sanitize each saved file's name and pair it with its type, or say (to the model) why the files cannot be
 * delivered. The sanitized name is the one stored, listed and shown.
 */
const toDeliverableFiles = (
  files: SavedFile[],
): { ok: true; files: DeliverableFile[] } | { ok: false; error: string } => {
  if (files.length === 0) {
    return {
      ok: false,
      error: 'The script finished without saving a file. Call saveFile(filename, bytes) for each file.',
    }
  }
  const seen = new Map<string, string>()
  const deliverable: DeliverableFile[] = []
  for (const file of files) {
    if (file.filename.length > maxFilenameLength) {
      return {
        ok: false,
        error: `A file name starting "${file.filename.slice(0, 40)}" is too long. Keep names under ${maxFilenameLength} characters.`,
      }
    }
    const { stem, extension } = safeFileName(file.filename)
    const type = fileTypes.find((candidate) => candidate.extension === extension)
    if (!type || /[/\\]/.test(file.filename)) {
      return {
        ok: false,
        error: `"${file.filename}" is not a valid file name. Use a name without folders that ends in .docx or .pptx.`,
      }
    }
    const filename = `${stem}.${extension}`
    const earlier = seen.get(filename)
    if (earlier !== undefined) {
      return {
        ok: false,
        error:
          earlier === file.filename
            ? `"${filename}" was saved twice. Give each file its own name.`
            : `"${earlier}" and "${file.filename}" both save as "${filename}". Give each file its own name.`,
      }
    }
    seen.set(filename, file.filename)
    deliverable.push({ ...file, filename, mimeType: type.mimeType })
  }
  return { ok: true, files: deliverable }
}

const officeScriptParameters = z.object({
  script: z
    .string()
    .describe(
      'JavaScript that runs as the body of an async function, so `await` works. Example: `const doc = new docx.Document({ sections: [{ children: [new docx.Paragraph("Hello")] }] }); saveFile("hello.docx", await docx.Packer.toArrayBuffer(doc))`',
    ),
})

export type OfficeScriptInput = z.infer<typeof officeScriptParameters>

/**
 * Build the tool around a script runner and a file store, so the tests can run the real VM in-process.
 * Each saved file becomes a new attachment-store entry; nothing is ever overwritten.
 */
export const createOfficeScriptTool = (
  runScript: (script: string, signal?: AbortSignal) => Promise<SandboxResult> = runInSandboxWorker,
  storeFiles: (files: StoredFile[]) => Promise<void> = putAttachments,
): ToolConfig => ({
  name: officeScriptToolName,
  description: [
    'Create a Word document (.docx) or a PowerPoint presentation (.pptx) that the user can download.',
    'Write a short JavaScript script. It runs in a sandbox where the `docx` library (global `docx`) and the `pptxgenjs` library (global `PptxGenJS`) are already loaded.',
    'Pass each finished file to `saveFile(filename, bytes)`. The name must end in .docx or .pptx. Get the bytes from `await docx.Packer.toArrayBuffer(doc)` or `await pres.write({ outputType: "uint8array" })`; `Packer.toBuffer`, `Packer.toBlob` and `pres.writeFile` do not work here.',
    'The sandbox has no network, no DOM, no fetch, no imports and no access to the chat or its attachments, so write all the content into the script.',
    'Each saved file appears in the chat for the user to download, so do not paste its contents into your reply.',
    `Limits per run: ${sandboxLimits.timeoutMs / 1000} seconds of script time (loading the libraries does not count), ${sandboxLimits.memoryBytes / 1024 / 1024} MiB of memory, ${sandboxLimits.textOutputBytes / 1024 / 1024} MiB of console output and ${sandboxLimits.maxFiles} files. If the result is { ok: false }, read the error: fix the script when the error is about it, then call the tool again.`,
  ].join(' '),
  verb: 'Creating file',
  parameters: officeScriptParameters,
  execute: async (
    { script }: OfficeScriptInput,
    options?: { abortSignal?: AbortSignal },
  ): Promise<OfficeScriptOutput> => {
    const result = await runScript(script, options?.abortSignal)
    if (!result.ok) {
      return result
    }
    const deliverable = toDeliverableFiles(result.files)
    if (!deliverable.ok) {
      return { ok: false, error: deliverable.error, logs: result.logs }
    }
    const records = deliverable.files.map(({ filename, mimeType, bytes }) => ({
      id: crypto.randomUUID(),
      filename,
      mimeType,
      size: bytes.byteLength,
      createdAt: Date.now(),
      blob: new Blob([bytes], { type: mimeType }),
    }))
    await storeFiles(records)
    const files = records.map(({ id, filename, mimeType }) => ({ id, filename, mimeType }))
    return { ok: true, files, logs: result.logs }
  },
})

/** Agent tool that runs a model-written script in a sandbox with the Office libraries and saves the files it makes. */
export const officeScriptTool = createOfficeScriptTool()
