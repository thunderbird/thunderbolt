/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { docxMime, pptxMime, xlsmMime, xlsxMime } from '@/files/transformers'
import { putAttachments, type StoredFile } from '@/lib/file-blob-storage'
import { safeFileName } from '@/lib/safe-file-name'
import { parseToolOutput } from '@/lib/tool-output'
import type { ToolConfig } from '@/types'
import { type DynamicToolUIPart, getToolName, isToolOrDynamicToolUIPart, type ToolUIPart, type UIMessage } from 'ai'
import { z } from 'zod'
import { maxFormulaErrors, officeScriptToolName, sandboxLimits } from './constants'
import { runInSandboxWorker } from './run-in-worker'
import type { FileFormulaError, SandboxJob, SandboxResult, SavedFile } from './sandbox'
import { type ReadWorkspaceFile, resolveInputs, type ThreadFile } from './script-inputs'

/**
 * A file the tool added to the attachment store, as listed in its result. The chips are built from this list.
 * `edited` is true when the script read a file of the same type, whatever name it saved this one under. `savedAs`
 * is the name the script gave it before cleaning, so a later run asking for that name finds this file.
 */
export type CreatedFile = { id: string; filename: string; mimeType: string; edited: boolean; savedAs?: string }

export type OfficeScriptOutput =
  | { ok: true; files: CreatedFile[]; logs: string; formulaErrors?: FileFormulaError[] }
  | { ok: false; error: string; logs: string }

/** A `run_office_script` tool call, whether emitted as a typed `tool-<name>` or a `dynamic-tool` part. */
export type OfficeScriptPart = ToolUIPart | DynamicToolUIPart

export const isOfficeScriptPart = (part: UIMessage['parts'][number]): part is OfficeScriptPart =>
  isToolOrDynamicToolUIPart(part) && getToolName(part) === officeScriptToolName

const createdFilesSchema = z.object({
  ok: z.literal(true),
  files: z.array(
    // Results stored before the tool could edit files have no `edited` or `savedAs`.
    z.object({
      id: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      edited: z.boolean().default(false),
      savedAs: z.string().optional(),
    }),
  ),
})

/** The files a finished, successful call created, or `undefined` while it runs and when it failed. */
export const officeScriptFiles = (part: OfficeScriptPart): CreatedFile[] | undefined =>
  parseToolOutput(createdFilesSchema, part)?.files

const fileTypes = [
  { extension: 'docx', mimeType: docxMime },
  { extension: 'xlsx', mimeType: xlsxMime },
  { extension: 'xlsm', mimeType: xlsmMime },
  { extension: 'pptx', mimeType: pptxMime },
]

// Checked before `safeFileName`, whose trimming backtracks on a long run of dots.
const maxFilenameLength = 200

type DeliverableFile = SavedFile & { mimeType: string; savedAs: string }

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
        error: `"${file.filename}" is not a valid file name. Use a name without folders that ends in .docx, .xlsx, .xlsm or .pptx.`,
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
    deliverable.push({ ...file, filename, mimeType: type.mimeType, savedAs: file.filename })
  }
  return { ok: true, files: deliverable }
}

const officeScriptParameters = z.object({
  script: z
    .string()
    .describe(
      'JavaScript that runs as the body of an async function, so `await` works. Example: `const doc = new docx.Document({ sections: [{ children: [new docx.Paragraph("Hello")] }] }); saveFile("hello.docx", await docx.Packer.toArrayBuffer(doc))`',
    ),
  inputs: z
    .array(z.string())
    .max(sandboxLimits.maxFiles)
    .optional()
    .describe('The files the script reads with `readFile(name)`, each by its file name or its id.'),
})

export type OfficeScriptInput = z.infer<typeof officeScriptParameters>

/** What the tool needs from the app. All are optional; the tests pass their own to run the real VM in-process. */
export type OfficeScriptToolDeps = {
  runScript?: (job: SandboxJob, signal?: AbortSignal) => Promise<SandboxResult>
  storeFiles?: (files: StoredFile[]) => Promise<void>
  /** The stored files of the chat thread: its attachments and the files this tool made in it, with their `savedAs`. */
  listThreadFiles?: () => Promise<ThreadFile[]>
  /** The built-in agent's workspace. The legacy pipeline has none. */
  readWorkspaceFile?: ReadWorkspaceFile
}

const mib = (bytes: number) => bytes / 1024 / 1024

const describeTool = (hasWorkspace: boolean) =>
  [
    'Create or edit a Word document (.docx), an Excel workbook (.xlsx, or .xlsm when it has macros) or a PowerPoint presentation (.pptx) that the user can download.',
    'Write a short JavaScript script. It runs in a sandbox where these libraries are already loaded: `docx` (global `docx`), `pptxgenjs` (global `PptxGenJS`), `excelize-wasm` (global `excelize`), `fflate` (global `fflate`) and `@xmldom/xmldom` (global `xmldom`).',
    'Pass each finished file to `saveFile(filename, bytes)`. The name must end in .docx, .xlsx, .xlsm or .pptx. Get the bytes from `await docx.Packer.toArrayBuffer(doc)`, `await pres.write({ outputType: "uint8array" })` or `f.WriteToBuffer().buffer`; `Packer.toBuffer`, `Packer.toBlob` and `pres.writeFile` do not work here.',
    `For a workbook, start with \`const f = excelize.NewFile()\` or \`const f = excelize.OpenReader(readFile(name))\`, then call its methods, such as \`f.SetCellValue("Sheet1", "B2", 1200)\`, \`f.SetCellFormula("Sheet1", "B5", "SUM(B2:B4)")\`, \`f.SetCellStyle("Sheet1", "B2", "B5", f.NewStyle({ NumFmt: 4 }).style)\` and \`f.AddChart(...)\`. They are synchronous and return what excelize-wasm returns; a call that fails throws an Error with the reason. Opening a workbook keeps what the script does not change, including styles, charts, images, pivot tables and macros. When the workbook is saved, every formula is computed and its result stored, so the file shows numbers even where nothing recalculates. A formula that could not be computed is listed in \`formulaErrors\` of the result with its file, sheet and cell (at most ${maxFormulaErrors}), and the file is saved anyway. \`excelize.OpenReader(bytes, { Password: "..." })\` opens a password-encrypted workbook, but \`WriteToBuffer\` takes no options and saves an unencrypted copy, so tell the user the copy no longer asks for a password; sheet and workbook protection (\`ProtectSheet\`, \`ProtectWorkbook\`) stay. Save a workbook that has macros as .xlsm, and one without as .xlsx. excelize opens workbooks of up to ${mib(sandboxLimits.maxWorkbookBytes)} MiB; for a larger one, tell the user it is too large to edit here instead of working around the limit. The chat cannot attach a .xlsm, so do not ask the user to upload one; a .xlsm this tool saved earlier in the chat${hasWorkspace ? ' or one in your workspace' : ''} can still be read and edited.`,
    `To read a file, list it in \`inputs\` and call \`readFile(name)\`, which returns its bytes as a Uint8Array. The files you can read are the ones attached in this chat and the ones this tool made earlier in it. Name a file by its file name to get the newest file with that name, or by its id to get that exact file, such as an older version.${hasWorkspace ? ' A name that matches none of them is read from your workspace, as a path relative to it, so a script can use data you prepared there.' : ''}`,
    'To edit a file, read it, change it, and save the result under exactly the same name, without a suffix such as "_edited" or "_v2": the user gets an edited copy, the original stays as it was, and the next edit finds the newest version by that name. `await docx.patchDocument({ outputType: "uint8array", data: readFile(name), patches })` replaces `{{key}}` placeholders and keeps everything else, including comments and tracked changes. For changes docx and PptxGenJS cannot make, such as adding a tracked change or copying a slide, unzip the file with `fflate.unzipSync`, edit its XML parts with `xmldom.DOMParser` and `xmldom.XMLSerializer` (`fflate.strFromU8` and `fflate.strToU8` convert the bytes), and zip it again with `fflate.zipSync`. Only the sync fflate functions work here.',
    'Every saved file is checked before it is stored. If a zip does not open or an XML part does not parse, nothing is saved, and the error names the file and, for XML, the part.',
    'The sandbox has no network, no DOM, no fetch and no imports, so write all new content into the script.',
    'Each saved file appears in the chat for the user to download, so save only the files the user asked for (check your work with console.log, not with test files), and do not paste their contents into your reply.',
    `Limits per run: ${sandboxLimits.timeoutMs / 1000} seconds of script time (loading the libraries does not count), ${mib(sandboxLimits.memoryBytes)} MiB of memory, ${mib(sandboxLimits.workbookMemoryBytes)} MiB of memory for excelize, ${mib(sandboxLimits.textOutputBytes)} MiB of console output and ${sandboxLimits.maxFiles} files. If the result is { ok: false }, read the error: fix the script when the error is about it, then call the tool again.`,
  ].join(' ')

/**
 * Build the tool for one send. Each saved file becomes a new attachment-store entry; nothing is ever overwritten.
 * The tool also keeps the files it made during the send, because the thread's stored messages lag behind the
 * turn that is still streaming.
 */
export const createOfficeScriptTool = ({
  runScript = runInSandboxWorker,
  storeFiles = putAttachments,
  listThreadFiles = async () => [],
  readWorkspaceFile,
}: OfficeScriptToolDeps = {}): ToolConfig => {
  const madeThisSend: ThreadFile[] = []
  return {
    name: officeScriptToolName,
    description: describeTool(readWorkspaceFile !== undefined),
    verb: 'Creating file',
    parameters: officeScriptParameters,
    execute: async (
      { script, inputs = [] }: OfficeScriptInput,
      options?: { abortSignal?: AbortSignal },
    ): Promise<OfficeScriptOutput> => {
      const threadFiles = inputs.length > 0 ? [...(await listThreadFiles()), ...madeThisSend] : []
      const resolved = await resolveInputs(inputs, threadFiles, readWorkspaceFile, sandboxLimits.memoryBytes)
      if (!resolved.ok) {
        return { ok: false, error: resolved.error, logs: '' }
      }
      const result = await runScript({ script, inputs: resolved.inputs }, options?.abortSignal)
      if (!result.ok) {
        return result
      }
      const deliverable = toDeliverableFiles(result.files)
      if (!deliverable.ok) {
        return { ok: false, error: deliverable.error, logs: result.logs }
      }
      const saved = deliverable.files.map(({ filename, mimeType, bytes, savedAs }) => ({
        record: {
          id: crypto.randomUUID(),
          filename,
          mimeType,
          size: bytes.byteLength,
          createdAt: Date.now(),
          blob: new Blob([bytes], { type: mimeType }),
        },
        savedAs,
      }))
      await storeFiles(saved.map(({ record }) => record))
      madeThisSend.push(...saved.map(({ record, savedAs }) => ({ ...record, savedAs })))
      // Models often rename the copy they edit, so the file type decides, not the name. The extension is at the
      // end, so the end of a long name is enough.
      const inputExtensions = new Set(
        resolved.filenames.map((name) => safeFileName(name.slice(-maxFilenameLength)).extension),
      )
      const files = saved.map(({ record: { id, filename, mimeType }, savedAs }) => ({
        id,
        filename,
        mimeType,
        edited: inputExtensions.has(safeFileName(filename).extension),
        savedAs,
      }))
      return { ok: true, files, logs: result.logs, formulaErrors: result.formulaErrors }
    },
  }
}
