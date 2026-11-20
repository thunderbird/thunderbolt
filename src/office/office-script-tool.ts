/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { docxMime, pptxMime, xlsmMime, xlsxMime } from '@/files/transformers'
import { putAttachments, type StoredFile } from '@/lib/file-blob-storage'
import { promptFileName, safeFileName } from '@/lib/safe-file-name'
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
 * `edited` is true when the file keeps the name of a file the script read. `savedAs` is the name the script gave it
 * before cleaning, so a later run asking for that name finds this file.
 */
export type CreatedFile = { id: string; filename: string; mimeType: string; edited: boolean; savedAs?: string }

/** `notes` flag saved files that are new even though the run read a file of their type. */
export type OfficeScriptOutput =
  | { ok: true; files: CreatedFile[]; logs: string; formulaErrors?: FileFormulaError[]; notes?: string[] }
  | { ok: false; error: string; logs: string; scriptId?: string; retry?: string }

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

/** A file name as the tool stores it. */
const cleanName = (name: string) => {
  const { stem, extension } = safeFileName(name)
  return `${stem}.${extension}`
}

const extensionOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()

/**
 * The note for a new file when the run read files of its type, or `undefined` when it read none. Asked to edit a
 * file, a model sometimes edits another one and saves it under the requested name. The note says this file is new
 * and sends the model to `inputs` for the named one; whether that file exists is left to the input resolver.
 */
const newFileNote = (filename: string, inputFilenames: string[]) => {
  const sameType = [...new Set(inputFilenames.filter((name) => extensionOf(name) === extensionOf(filename)))]
  if (sameType.length === 0) {
    return undefined
  }
  const name = promptFileName(filename)
  return `${name} is a new file made from ${sameType.map(promptFileName).join(', ')}, not an edit of a file with that name. If the user asked you to edit ${name}, list that exact name in \`inputs\`: the tool then reads that file or says it does not exist. Do not present this file as the edited one.`
}

/** The thread's files this tool made, once each: only those carry the name the script gave them. */
const madeByTool = (files: ThreadFile[]) => [
  ...new Map(files.filter(({ savedAs }) => savedAs !== undefined).map((file) => [file.id, file])).values(),
]

/**
 * Sanitize each saved file's name and pair it with its type, or say (to the model) why the files cannot be
 * delivered. The sanitized name is the one stored, listed and shown.
 */
const toDeliverableFiles = (
  files: SavedFile[],
  inputFilenames: string[],
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
        error: `A file name starting ${promptFileName(file.filename.slice(0, 40))} is too long. Keep names under ${maxFilenameLength} characters.`,
      }
    }
    const { stem, extension } = safeFileName(file.filename)
    const type = fileTypes.find((candidate) => candidate.extension === extension)
    if (!type || /[/\\]/.test(file.filename)) {
      return {
        ok: false,
        error: `${promptFileName(file.filename)} is not a valid file name. Use a name without folders that ends in .docx, .xlsx, .xlsm or .pptx.`,
      }
    }
    // The output check requires a .xlsm to have macros, so a .xlsm made from scratch or from a .xlsx would gain some.
    if (extension === 'xlsm' && !inputFilenames.some((name) => /\.xlsm$/i.test(name))) {
      return {
        ok: false,
        error: `${promptFileName(file.filename)} would be a workbook with macros, but this run read none. This tool keeps the macros of a workbook that has them and never adds any, so save it as .xlsx.`,
      }
    }
    const filename = `${stem}.${extension}`
    const earlier = seen.get(filename)
    if (earlier !== undefined) {
      return {
        ok: false,
        error:
          earlier === file.filename
            ? `${promptFileName(filename)} was saved twice. Give each file its own name.`
            : `${promptFileName(earlier)} and ${promptFileName(file.filename)} both save as ${promptFileName(filename)}. Give each file its own name.`,
      }
    }
    seen.set(filename, file.filename)
    deliverable.push({ ...file, filename, mimeType: type.mimeType, savedAs: file.filename })
  }
  return { ok: true, files: deliverable }
}

const maxRetryLength = 128 * 1024
const maxReplacements = 32

const officeScriptParameters = z.object({
  script: z
    .string()
    .min(1)
    .nullish()
    .describe(
      'JavaScript that runs as the body of an async function, so `await` works. Example: `const doc = new docx.Document({ sections: [{ children: [new docx.Paragraph("Hello")] }] }); saveFile("hello.docx", await docx.Packer.toArrayBuffer(doc))`',
    ),
  edit: z
    .object({
      scriptId: z.string(),
      replacements: z
        .array(z.object({ find: z.string().min(1), replace: z.string() }))
        .max(maxReplacements)
        .describe(
          'Applied in order. Each find must occur exactly once. Use [] with explicit inputs to change only inputs.',
        ),
    })
    .nullish(),
  inputs: z
    .array(z.string())
    .max(sandboxLimits.maxFiles)
    .nullish()
    .describe(
      'The files the script reads with `readFile(name)`, each by its file name or its id. On edit, omitted or null inherits the previous references.',
    ),
})

export type OfficeScriptInput = z.infer<typeof officeScriptParameters>

type ScriptSource = { script: string; inputs: string[] }
/** Space left for source after accounting for the cached input references (UTF-16 code units). */
const maxSourceLength = (inputs: string[]) => inputs.reduce((remaining, ref) => remaining - ref.length, maxRetryLength)

/** Claim a retained source only after every literal edit has succeeded. */
const resolveSource = (
  { script, edit, inputs }: OfficeScriptInput,
  failures: Map<string, ScriptSource>,
): ScriptSource | { error: string } => {
  if (script && !edit) {
    return { script, inputs: inputs ?? [] }
  }
  if (script != null || !edit) {
    return { error: 'Provide exactly one of a full script or an edit against a failed scriptId.' }
  }
  const base = failures.get(edit.scriptId)
  if (!base) {
    return {
      error: 'Unknown or expired scriptId. Check any other retry result first, then send the full script if needed.',
    }
  }
  if (!edit.replacements.length && inputs == null) {
    return { error: 'Supply at least one replacement or an explicit inputs list.' }
  }
  if (
    edit.replacements.length > maxReplacements ||
    edit.replacements.reduce((n, r) => n + r.find.length + r.replace.length, 0) > maxRetryLength
  ) {
    return { error: 'Edit too large. Send the full script.' }
  }
  const refs = inputs ?? base.inputs
  const maxScriptLength = maxSourceLength(refs)
  let edited = base.script
  for (const [i, { find, replace }] of edit.replacements.entries()) {
    const index = edited.indexOf(find)
    let matches = 0
    if (find.length) {
      for (let at = index; at !== -1; at = edited.indexOf(find, at + 1)) {
        matches++
      }
    }
    if (matches !== 1) {
      return {
        error: `Replacement ${i + 1}: ${matches} matches. Use a nonempty, unique find and retry the same scriptId.`,
      }
    }
    if (edited.length - find.length + replace.length > maxScriptLength) {
      return { error: 'Edited script too large. Send the full script.' }
    }
    edited = edited.slice(0, index) + replace + edited.slice(index + find.length)
  }
  if (edited.length > maxScriptLength) {
    return { error: 'Edited script and inputs too large. Send the full script.' }
  }
  failures.delete(edit.scriptId)
  return { script: edited, inputs: refs }
}

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
    'Create or edit a Word document (.docx), an Excel workbook (.xlsx, or .xlsm when you edit one that has macros) or a PowerPoint presentation (.pptx) that the user can download.',
    'Write a short script using the loaded globals: `docx`, `PptxGenJS`, `excelize` (excelize-wasm), `fflate` and `xmldom` (@xmldom/xmldom).',
    'If a failed result includes `scriptId`, retry in this send with `edit` containing that ID and exact `find`/`replace` pairs in `replacements`.',
    'Build each requested file in one call. Check the finished bytes in memory (e.g. unzip and read back the changed parts), then save once as the final step with `saveFile(filename, bytes)`. Every saved file is shown to the user as a deliverable, so never save a test, draft or scratch file; keep intermediate bytes in memory. Do not save a file again to adjust it: call again for a file only to fix a reported error, for a new user request, or for requested files a run could not fit. The name must end in .docx, .xlsx, .xlsm or .pptx. Get the bytes for Word from `await docx.Packer.toArrayBuffer(doc)` and for Excel from `f.WriteToBuffer().buffer`; `Packer.toBuffer`, `Packer.toBlob` and `pres.writeFile` do not work here.',
    "Give each PowerPoint animation target a unique objectName. For a 13⅓ × 7½ inch canvas set pres.layout = 'LAYOUT_WIDE' before adding slides. Get bytes from await pres.write({outputType:'uint8array'}) or readFile(name). Example: const out = animatePptx(bytes, {effects:[{slide:1, shape:'badge', effect:'blink', start:'withPrevious', repeat:'indefinite'}], transitions:[{slide:1, effect:'fade'}]}). Check out and saveFile(name,out) once.",
    "Slides are 1-based in presentation order. Effects run in entry order: appear, fadeIn, flyIn, wipeIn, blink, pulse, growShrink, spin, disappear, fadeOut. Start defaults to onClick. Use withPrevious for simultaneous effects or slide entry, afterPrevious after a finite group, delayMs for a wait, durationMs for a timed cycle, repeat for total plays or 'indefinite'. Transitions are fade, wipe, push, zoom, cover and dissolve with optional speed fast/medium/slow. The direction option takes a from-edge top/right/bottom/left for flyIn, wipeIn, wipe, push and cover, or in/out for zoom. Use fflate and xmldom for other effects, custom paths or edits to existing timing or transitions.",
    `For a workbook, start with \`const f = excelize.NewFile()\` or \`const f = excelize.OpenReader(readFile(name))\`, then call its methods, such as \`f.SetCellValue("Sheet1", "B2", 1200)\`, \`f.SetCellFormula("Sheet1", "B5", "SUM(B2:B4)")\`, \`f.SetCellStyle("Sheet1", "B2", "B5", f.NewStyle({ NumFmt: 4 }).style)\` and \`f.AddChart(...)\`. They are synchronous and return what excelize-wasm returns; a call that fails throws an Error with the reason. For money, set the format with \`CustomNumFmt\` and quote the symbol or give a locale tag, such as \`f.NewStyle({ CustomNumFmt: '"R$" #,##0.00' })\` or \`'[$€-407] #,##0.00'\`: \`NumFmt\` 5 to 8 are not saved, and an unquoted \`R$\` shows as a plain number. Opening a workbook keeps what the script does not change, including styles, charts, images, pivot tables and macros. When the workbook is saved, every formula is computed and its result stored, so the file shows numbers even where nothing recalculates. A formula that could not be computed is listed with its sheet and cell in \`formulaErrors\` of what \`WriteToBuffer\` returns, so log that instead of saving a test file, and again in the tool result with its file (at most ${maxFormulaErrors}); the file is saved anyway. Never rebuild an attached workbook from its extracted text or the copy in your workspace: that loses its formulas and formatting. Open it with excelize, or tell the user why you cannot. \`excelize.OpenReader(bytes, { Password: "..." })\` opens a password-encrypted workbook, but \`WriteToBuffer\` takes no options and saves an unencrypted copy, so tell the user the copy no longer asks for a password; sheet and workbook protection (\`ProtectSheet\`, \`ProtectWorkbook\`) stay. This tool never adds macros: \`AddVBAProject\` throws, and a .xlsm can be saved only from a .xlsm the run read, under its own extension. Save every other workbook as .xlsx, including one opened from a .xlsx. excelize opens workbooks of up to ${mib(sandboxLimits.maxWorkbookBytes)} MiB; for a larger one, tell the user it is too large to edit here instead of working around the limit. The chat cannot attach a .xlsm, so do not ask the user to upload one; a .xlsm this tool saved earlier in the chat${hasWorkspace ? ' or one in your workspace' : ''} can still be read and edited.`,
    `To read a file, list it in \`inputs\` and call \`readFile(name)\`, which returns its bytes as a Uint8Array. The files you can read are the ones attached in this chat and the ones this tool made earlier in it. Name a file by its file name to get the newest file with that name, or by its id to get that exact file, such as an older version.${hasWorkspace ? ' A name that matches none of them is read from your workspace, as a path relative to it, so a script can use data you prepared there.' : ''}`,
    'When the user names a file, list that exact name in `inputs`, even when another file is attached. If no file has that name, the call fails and lists the files there are: ask the user which one they mean. Never edit a different file in its place, and never save under the name of a file that does not exist unless the user asked for a new file.',
    'To edit a file, read it, change it, and save the result under exactly the same name, without a suffix such as "_edited" or "_v2": the user gets an edited copy, the original stays as it was, and the next edit finds the newest version by that name. A file saved under another name is a new file, and `notes` in the result say so. `await docx.patchDocument({ outputType: "uint8array", data: readFile(name), patches })` replaces `{{key}}` placeholders and keeps everything else, including comments and tracked changes. For changes docx and PptxGenJS cannot make, such as adding a tracked change or copying a slide, unzip the file with `fflate.unzipSync`, edit its XML parts with `xmldom.DOMParser` and `xmldom.XMLSerializer` (`fflate.strFromU8` and `fflate.strToU8` convert the bytes), and zip it again with `fflate.zipSync`. Only the sync fflate functions work here.',
    `Every saved file is checked before it is stored. If a zip does not open, unzips to more than ${mib(sandboxLimits.unzipBytes)} MiB or has a part name that is not a plain path inside it, or an XML part does not parse or holds a DDE field, nothing is saved, and the error names the file and, for XML, the part. The same goes for a file that adds a remote template, an external link or an OLE object that no file of its type the run read had, and for a file saved with no change from a file the run read. Leave the parts you were not asked to change as they are, even when their XML declares an encoding such as windows-1252.`,
    'The sandbox has no network, DOM, fetch, imports or Node globals (require, Buffer, fs, process), so write all new content into the script. Use Uint8Array for bytes and fflate for ZIPs.',
    'Each saved file appears in the chat for the user to download, so save only the files the user asked for, and do not paste their contents into your reply.',
    `Limits per run: ${sandboxLimits.timeoutMs / 1000} seconds of script time (loading the libraries does not count), ${mib(sandboxLimits.memoryBytes)} MiB of memory, ${mib(sandboxLimits.workbookMemoryBytes)} MiB of memory for excelize, ${mib(sandboxLimits.textOutputBytes)} MiB of console output and ${sandboxLimits.maxFiles} files. The files this tool makes in one chat may take ${mib(sandboxLimits.threadFileBytes)} MiB in all. If the result is { ok: false }, read the error: fix the script when the error is about it, then call the tool again.`,
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
  const failures = new Map<string, ScriptSource>()
  // Bytes that calls in this send are still storing, so calls running together cannot pass the chat's limit.
  let storingBytes = 0
  return {
    name: officeScriptToolName,
    description: describeTool(readWorkspaceFile !== undefined),
    verb: 'Creating file',
    parameters: officeScriptParameters,
    execute: async (input: OfficeScriptInput, options?: { abortSignal?: AbortSignal }): Promise<OfficeScriptOutput> => {
      const source = resolveSource(input, failures)
      if ('error' in source) {
        return { ok: false, error: source.error, logs: '' }
      }
      const { script, inputs } = source
      const fail = (error: string, logs: string): OfficeScriptOutput => {
        if (script.length > maxSourceLength(inputs)) {
          return { ok: false, error: `${error} To retry, send the full script.`, logs }
        }
        const scriptId = crypto.randomUUID()
        if (failures.size === 4) {
          failures.delete(failures.keys().next().value!)
        }
        failures.set(scriptId, { script, inputs: [...inputs] })
        // Models follow an instruction in the result more reliably than the same rule in the tool description.
        const retry = `To fix it, call again with edit: { scriptId: "${scriptId}", replacements: [{ find, replace }] }, each find copied exactly from the script, instead of sending the whole script again.`
        return { ok: false, error, logs, scriptId, retry }
      }
      const threadFiles = [...(await listThreadFiles()), ...madeThisSend]
      const resolved = await resolveInputs(inputs, threadFiles, readWorkspaceFile, sandboxLimits.memoryBytes)
      if (!resolved.ok) {
        return fail(resolved.error, '')
      }
      const result = await runScript({ script, inputs: resolved.inputs }, options?.abortSignal)
      if (!result.ok) {
        return fail(result.error, result.logs)
      }
      const deliverable = toDeliverableFiles(result.files, resolved.filenames)
      if (!deliverable.ok) {
        return fail(deliverable.error, result.logs)
      }
      // Counted after the script, to include calls that finished or started storing while it ran.
      const storedBytes =
        madeByTool([...threadFiles, ...madeThisSend]).reduce((total, file) => total + file.size, 0) + storingBytes
      const newBytes = deliverable.files.reduce((total, { bytes }) => total + bytes.byteLength, 0)
      if (storedBytes + newBytes > sandboxLimits.threadFileBytes) {
        return fail(
          `The files this tool made in this chat take ${mib(storedBytes).toFixed(1)} MiB, and these would take it past the ${mib(sandboxLimits.threadFileBytes)} MiB one chat may hold. Nothing was saved. Tell the user, and suggest a new chat for more files.`,
          result.logs,
        )
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
      storingBytes += newBytes
      try {
        await storeFiles(saved.map(({ record }) => record))
        madeThisSend.push(...saved.map(({ record, savedAs }) => ({ ...record, savedAs })))
      } finally {
        storingBytes -= newBytes
      }
      // An edit keeps the name of the file it was read from; a new file made from one gets a name of its own.
      const inputNames = new Set(resolved.filenames.filter((name) => name.length <= maxFilenameLength).map(cleanName))
      const files = saved.map(({ record: { id, filename, mimeType }, savedAs }) => ({
        id,
        filename,
        mimeType,
        edited: inputNames.has(filename),
        savedAs,
      }))
      const notes = files
        .filter(({ edited }) => !edited)
        .flatMap(({ filename }) => newFileNote(filename, resolved.filenames) ?? [])
      return {
        ok: true,
        files,
        logs: result.logs,
        formulaErrors: result.formulaErrors,
        notes: notes.length > 0 ? notes : undefined,
      }
    },
  }
}
