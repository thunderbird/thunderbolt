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
import { officeScriptToolName, officeSkillNames, sandboxLimits } from './constants'
import { runInSandboxWorker } from './run-in-worker'
import type { FileFormulaError, SandboxJob, SandboxResult, SavedFile } from './sandbox'
import { type ReadWorkspaceFile, resolveInputs, type ThreadFile } from './script-inputs'

/**
 * A file the tool added to the attachment store, as listed in its result. The chips are built from this list.
 * `edited` is true when the file keeps the name of a file the script read. `savedAs` is the name the script gave it
 * before cleaning, so a later run asking for that name finds this file.
 */
export type CreatedFile = { id: string; filename: string; mimeType: string; edited: boolean; savedAs?: string }

/** `notes` flag saved files that are new even though the run read a file of their type, or a run that saved none. */
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
    .describe('JavaScript that runs as the body of an async function, so `await` works.'),
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
  /** Names of the Office skills the model can load in this send. The description tells it to load them first. */
  skills?: string[]
}

const mib = (bytes: number) => bytes / 1024 / 1024

/**
 * The description sent with every request, so it holds only the tool's contract. How to use each library lives in
 * the Office skills (`./skills`), which the model loads on demand.
 */
const describeTool = (hasWorkspace: boolean, skills: string[]) =>
  [
    'Create or edit a Word (.docx), Excel (.xlsx, or .xlsm when editing one with macros) or PowerPoint (.pptx) file for the user to download.',
    skills.length > 0
      ? `Before writing or editing a script, load the listed Office skill for each format you will use, unless its instructions are already in context: ${skills.join(', ')}.`
      : '',
    'Globals: `docx`, `PptxGenJS`, `excelize` (excelize-wasm), `animatePptx`, `fflate` (sync only), `xmldom`, `readFile(name)` (a Uint8Array) and `saveFile(name, bytes)`. Bytes come from `await docx.Packer.toArrayBuffer(doc)`, `f.WriteToBuffer().buffer` or `await pres.write({ outputType: "uint8array" })`. No network, DOM, imports or Node globals.',
    'Build each requested file in one call and save it once, as the last step. Every saved file is shown to the user, so never save a test or draft, and do not save a file again to adjust it. A run that saves nothing succeeds and returns its console output in `logs`: use it to inspect a file or try an API.',
    `List each file the script reads in \`inputs\`: one attached in this chat or made by this tool in it, by name for the newest or by id for that version.${hasWorkspace ? ' Other names are paths in your workspace.' : ''} When the user names a file, list that exact name; if it is missing, the call fails and lists the files: ask the user, never edit another file instead.`,
    'To edit a file, open it with `readFile` (rebuilding it from extracted text loses formulas and formatting) and save it under exactly the same name, with no suffix such as "_v2"; another name makes a new file.',
    'Nothing is saved if a file has a broken zip or XML part or a DDE field, adds a remote template, external link, external Word field or OLE object its input lacked, or is an unchanged copy of an input.',
    'A password-protected workbook opens but saves unencrypted: tell the user. Macros are kept, never added.',
    `Limits per run: ${sandboxLimits.timeoutMs / 1000} s, ${mib(sandboxLimits.memoryBytes)} MiB of memory (${mib(sandboxLimits.workbookMemoryBytes)} MiB for excelize), ${mib(sandboxLimits.textOutputBytes)} MiB of logs, ${sandboxLimits.maxFiles} files, ${mib(sandboxLimits.unzipBytes)} MiB unzipped per file; ${mib(sandboxLimits.threadFileBytes)} MiB of files per chat.`,
    'If a failed result has `scriptId`, fix it with `edit: { scriptId, replacements: [{ find, replace }] }`.',
    'Do not paste a saved file into your reply.',
  ]
    .filter(Boolean)
    .join(' ')

/** Each format's skill, by what names the format in an error or a script. */
const skillFormats = [
  { skill: officeSkillNames.xlsx, pattern: /excelize|xls[xm]/i },
  { skill: officeSkillNames.docx, pattern: /docx/i },
  { skill: officeSkillNames.pptx, pattern: /pptx/i },
]

const cellHint =
  'Cells are A1 names: f.SetCellValue("Sheet1", "B2", 1200) and f.SetCellFormula("Sheet1", "F2", "SUM(C2:E2)") with no leading "="; from numbers use excelize.CoordinatesToCellName(col, row).cell.'
const styleHint =
  'Style options are objects and colors are arrays: f.NewStyle({ Fill: { Type: "pattern", Pattern: 1, Color: ["#FFC7CE"] }, CustomNumFmt: \'"R$" #,##0.00\' }).style. NewConditionalStyle ids are a separate sequence that starts at 0.'

/** How to call the Excelize methods models most often get wrong, for a send whose Excel skill is not available. */
const excelizeHints = new Map([
  [
    'SetConditionalFormat',
    'SetConditionalFormat takes an array of rules: f.SetConditionalFormat("Sheet1", "A2:F13", [{ Type: "formula", Criteria: "$F2>$B2", Format: f.NewConditionalStyle({ Font: { Color: "#9C0006" } }).style }]).',
  ],
  [
    'AddChart',
    'AddChart takes an object with a type constant: f.AddChart("Sheet1", "H2", { Type: excelize.Col, Series: [{ Name: "Sheet1!$F$1", Categories: "Sheet1!$A$2:$A$13", Values: "Sheet1!$F$2:$F$13" }], Title: { Paragraph: [{ Text: "Totals" }] } }).',
  ],
  ['SetCellValue', cellHint],
  ['SetCellFormula', cellHint],
  ['NewStyle', styleHint],
  ['NewConditionalStyle', styleHint],
  ['SetColWidth', 'Columns are letters: f.SetColWidth("Sheet1", "A", "F", 15).'],
])

/**
 * One sentence for a failed script: load the skill for the format that failed, when the send offers it, or else how
 * to call the Excelize method that failed. The format comes from the error, or from the script when the error names
 * none. Undefined when there is nothing specific to say.
 */
const failureHint = (error: string, script: string, skills: string[]) => {
  // workbook-bridge.ts says this for a workbook too large to open, which no retry or skill can fix.
  if (error.includes('Stop and tell the user')) {
    return undefined
  }
  const named = (text: string) => skillFormats.filter(({ pattern }) => pattern.test(text)).map(({ skill }) => skill)
  const formats = named(error).length > 0 ? named(error) : named(script)
  const available = formats.filter((skill) => skills.includes(skill))
  if (available.length > 0) {
    return `Before you fix this, load the Office skill for this format unless its instructions are already in context: ${available.join(', ')}.`
  }
  // Excelize failures start with the method's name; see `settle` in workbook-bridge.ts.
  const method = /^\w*Error: (\w+): /.exec(error)?.[1]
  return method === undefined ? undefined : excelizeHints.get(method)
}

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
  skills = [],
}: OfficeScriptToolDeps = {}): ToolConfig => {
  const madeThisSend: ThreadFile[] = []
  const failures = new Map<string, ScriptSource>()
  // Bytes that calls in this send are still storing, so calls running together cannot pass the chat's limit.
  let storingBytes = 0
  // A send gets one hint: repeated, it would only lengthen each later error.
  let hinted = false
  return {
    name: officeScriptToolName,
    description: describeTool(readWorkspaceFile !== undefined, skills),
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
        const hint = hinted ? undefined : failureHint(result.error, script, skills)
        hinted ||= hint !== undefined
        return fail(hint === undefined ? result.error : `${result.error.trimEnd()}\n${hint}`, result.logs)
      }
      if (result.files.length === 0) {
        return {
          ok: true,
          files: [],
          logs: result.logs,
          notes: ['No file was saved, so the user sees nothing from this run.'],
        }
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
