/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The four coding tools (bash/read/write/edit) as PLAIN Pi {@link AgentTool}
 * objects bound directly to a {@link BrowserExecutionEnv}.
 *
 * This is the in-browser replacement for Pi's `@earendil-works/pi-coding-agent`
 * tool factories. Those factories are a Node CLI: importing them transitively
 * pulls `cross-spawn`/`which`/`undici`/`graceful-fs` and a TUI renderer, forcing
 * a stack of browser stubs and vite aliases. The model, however, only ever sees a
 * tool's `name`, `description`, and parameter schema — so we replicate those
 * verbatim from Pi (the model's priors depend on the exact wording) while
 * implementing `execute` over the same ZenFS-backed operation adapters the CLI
 * tools were given via their `operations` option (see
 * `../browser-env/coding-tool-operations.ts`). The Node-coupled factories are
 * therefore never imported on the app path, and their dependency cascade is gone.
 *
 * Dropped vs. the CLI tools (all TUI/CLI-only, invisible to the model):
 *   - `renderCall`/`renderResult` (pi-tui terminal rendering);
 *   - the edit tool's `diff`/`patch` details (the app never renders them);
 *   - the per-file mutation queue — replaced by marking the mutating tools
 *     (`bash`/`write`/`edit`) `executionMode: 'sequential'`. Pi's agent loop runs
 *     a tool batch in parallel by default, but serializes the whole batch as soon
 *     as one of its tools is sequential, so a model that emits `write` + `edit` on
 *     the same file in one turn can't race them over the shared ZenFS mount.
 *
 * `Buffer` is used for byte-accurate truncation and to decode operation output;
 * the app installs the global `Buffer` polyfill before any tool runs.
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { TextContent } from '@earendil-works/pi-ai'
import { dirname } from '@zenfs/core/path'
import { Type, type Static } from 'typebox'
import type { BrowserExecutionEnv } from '../browser-env/browser-execution-env.ts'
import { resolveInWorkspace } from '../browser-env/workspace-jail.ts'
import {
  createBashOperations,
  createEditOperations,
  createReadOperations,
  createWriteOperations,
} from '../browser-env/coding-tool-operations.ts'
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type EditReplacement,
} from './edit-apply.ts'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateTail } from './truncate.ts'

/** Wrap plain text as a single-block tool result with no structured details. */
const textResult = (text: string): AgentToolResult<undefined> => ({
  content: [{ type: 'text', text } satisfies TextContent],
  details: undefined,
})

/** Throw Pi's abort error if the run was cancelled. Checked between awaits so an
 *  in-flight ZenFS operation settles before we bail. */
const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new Error('Operation aborted')
  }
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

const bashSchema = Type.Object({
  command: Type.String({ description: 'Bash command to execute' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' })),
})

/** Persist full (untruncated) bash output to a ZenFS temp file so the model can
 *  `cat` it; returns the path, or undefined if the write failed. */
const persistFullOutput = async (env: BrowserExecutionEnv, output: string): Promise<string | undefined> => {
  const tmp = await env.createTempFile({ prefix: 'pi-bash-', suffix: '.log' })
  if (!tmp.ok) {
    return undefined
  }
  const written = await env.writeFile(tmp.value, output)
  return written.ok ? tmp.value : undefined
}

/** Tail-truncate bash output and, when truncated, append Pi's "[Showing lines …]"
 *  footer pointing at the persisted full-output file. */
const formatBashOutput = async (env: BrowserExecutionEnv, output: string, emptyText: string): Promise<string> => {
  const truncation = truncateTail(output)
  if (!truncation.truncated) {
    return truncation.content || emptyText
  }
  const fullOutputPath = await persistFullOutput(env, output)
  const fullOutputNote = fullOutputPath ? ` Full output: ${fullOutputPath}` : ''
  const startLine = truncation.totalLines - truncation.outputLines + 1
  const endLine = truncation.totalLines
  if (truncation.lastLinePartial) {
    return `${truncation.content}\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}.${fullOutputNote}]`
  }
  if (truncation.truncatedBy === 'lines') {
    return `${truncation.content}\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.${fullOutputNote}]`
  }
  return `${truncation.content}\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).${fullOutputNote}]`
}

/** `${text}\n\n${status}`, or just `status` when there is no captured output. */
const appendStatus = (text: string, status: string): string => `${text ? `${text}\n\n` : ''}${status}`

const buildBashTool = (env: BrowserExecutionEnv, cwd: string): AgentTool<typeof bashSchema> => {
  const operations = createBashOperations(env)
  return {
    name: 'bash',
    label: 'bash',
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: bashSchema,
    // Mutates the shared ZenFS mount (redirects, file writes); serialize the batch.
    executionMode: 'sequential',
    async execute(_toolCallId, { command, timeout }, signal) {
      const chunks: string[] = []
      const onData = (data: Buffer): void => {
        chunks.push(data.toString('utf-8'))
      }
      let exitCode: number | null
      try {
        const result = await operations.exec(command, cwd, { onData, signal, timeout })
        exitCode = result.exitCode
      } catch (error) {
        // operations.exec re-throws the env's ExecutionError, whose `.message`
        // already carries Pi's `aborted` / `timeout:<seconds>` framing.
        const text = await formatBashOutput(env, chunks.join(''), '')
        if (error instanceof Error && error.message === 'aborted') {
          throw new Error(appendStatus(text, 'Command aborted'))
        }
        if (error instanceof Error && error.message.startsWith('timeout:')) {
          throw new Error(appendStatus(text, `Command timed out after ${error.message.split(':')[1]} seconds`))
        }
        throw error
      }
      const text = await formatBashOutput(env, chunks.join(''), '(no output)')
      if (exitCode !== 0 && exitCode !== null) {
        throw new Error(appendStatus(text, `Command exited with code ${exitCode}`))
      }
      return textResult(text)
    },
  }
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

const readSchema = Type.Object({
  path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
  offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-indexed)' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
})

/** Build the read tool's text output: applies offset/limit, head-truncates, and
 *  appends Pi's actionable continuation hints (`Use offset=N to continue`). */
const formatReadOutput = (
  rawPath: string,
  textContent: string,
  offset: number | undefined,
  limit: number | undefined,
): string => {
  const allLines = textContent.split('\n')
  const totalFileLines = allLines.length
  const startLine = offset ? Math.max(0, offset - 1) : 0
  const startLineDisplay = startLine + 1
  if (startLine >= allLines.length) {
    throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`)
  }

  const endLine = limit !== undefined ? Math.min(startLine + limit, allLines.length) : allLines.length
  const userLimitedLines = limit !== undefined ? endLine - startLine : undefined
  const selectedContent = allLines.slice(startLine, endLine).join('\n')
  const truncation = truncateHead(selectedContent)

  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], 'utf-8'))
    return `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${rawPath} | head -c ${DEFAULT_MAX_BYTES}]`
  }
  if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1
    const nextOffset = endLineDisplay + 1
    const limitNote = truncation.truncatedBy === 'lines' ? '' : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`
    return `${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}${limitNote}. Use offset=${nextOffset} to continue.]`
  }
  if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines)
    const nextOffset = startLine + userLimitedLines + 1
    return `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`
  }
  return truncation.content
}

const buildReadTool = (cwd: string): AgentTool<typeof readSchema> => {
  const operations = createReadOperations()
  return {
    name: 'read',
    label: 'read',
    description: `Read the contents of a file. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readSchema,
    async execute(_toolCallId, { path, offset, limit }, signal) {
      const absolutePath = resolveInWorkspace(cwd, path)
      throwIfAborted(signal)
      await operations.access(absolutePath)
      throwIfAborted(signal)
      const buffer = await operations.readFile(absolutePath)
      return textResult(formatReadOutput(path, buffer.toString('utf-8'), offset, limit))
    },
  }
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

const writeSchema = Type.Object({
  path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
  content: Type.String({ description: 'Content to write to the file' }),
})

const buildWriteTool = (cwd: string): AgentTool<typeof writeSchema> => {
  const operations = createWriteOperations()
  return {
    name: 'write',
    label: 'write',
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    // Serialize against other file mutations in the same batch (no per-path queue).
    executionMode: 'sequential',
    async execute(_toolCallId, { path, content }, signal) {
      const absolutePath = resolveInWorkspace(cwd, path)
      throwIfAborted(signal)
      await operations.mkdir(dirname(absolutePath))
      throwIfAborted(signal)
      await operations.writeFile(absolutePath, content)
      return textResult(`Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${path}`)
    },
  }
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({
      description:
        'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
    }),
    newText: Type.String({ description: 'Replacement text for this targeted edit.' }),
  },
  { additionalProperties: false },
)

const editSchema = Type.Object(
  {
    path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
    edits: Type.Array(replaceEditSchema, {
      description:
        'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
    }),
  },
  { additionalProperties: false },
)

type EditInput = Static<typeof editSchema>

/** Drop `oldText`/`newText` from a record, keeping every other key. */
const withoutLegacyEditKeys = (args: Record<string, unknown>): Record<string, unknown> => {
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (key !== 'oldText' && key !== 'newText') {
      rest[key] = value
    }
  }
  return rest
}

/**
 * Normalize raw model arguments into the edit schema's shape before validation.
 * Some models emit `edits` as a JSON string (Opus 4.6, GLM-5.1) or a single
 * top-level `oldText`/`newText` pair instead of the `edits[]` array; fold both
 * into `edits[]` so the tool's contract stays uniform.
 */
const prepareEditArguments = (input: unknown): EditInput => {
  if (!input || typeof input !== 'object') {
    return input as EditInput
  }
  const args: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  if (typeof args.edits === 'string') {
    try {
      const parsed: unknown = JSON.parse(args.edits)
      if (Array.isArray(parsed)) {
        args.edits = parsed
      }
    } catch {
      // Not JSON — leave `edits` untouched so validation surfaces a clear error.
    }
  }
  if (typeof args.oldText !== 'string' || typeof args.newText !== 'string') {
    return args as EditInput
  }
  const edits = Array.isArray(args.edits) ? [...args.edits] : []
  edits.push({ oldText: args.oldText, newText: args.newText })
  return { ...withoutLegacyEditKeys(args), edits } as EditInput
}

/** Validate that at least one replacement was provided. */
const validateEditInput = (input: EditInput): { path: string; edits: EditReplacement[] } => {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error('Edit tool input is invalid. edits must contain at least one replacement.')
  }
  return { path: input.path, edits: input.edits }
}

const buildEditTool = (cwd: string): AgentTool<typeof editSchema> => {
  const operations = createEditOperations()
  return {
    name: 'edit',
    label: 'edit',
    description:
      'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.',
    parameters: editSchema,
    // Serialize against other file mutations in the same batch (no per-path queue).
    executionMode: 'sequential',
    prepareArguments: prepareEditArguments,
    async execute(_toolCallId, input, signal) {
      const { path, edits } = validateEditInput(input)
      const absolutePath = resolveInWorkspace(cwd, path)
      throwIfAborted(signal)
      try {
        await operations.access(absolutePath)
      } catch (error) {
        const reason = error instanceof Error && 'code' in error ? `Error code: ${error.code}` : String(error)
        throw new Error(`Could not edit file: ${path}. ${reason}.`)
      }
      throwIfAborted(signal)
      const buffer = await operations.readFile(absolutePath)
      const { bom, text: content } = stripBom(buffer.toString('utf-8'))
      const originalEnding = detectLineEnding(content)
      const { newContent } = applyEditsToNormalizedContent(normalizeToLF(content), edits, path)
      throwIfAborted(signal)
      await operations.writeFile(absolutePath, bom + restoreLineEndings(newContent, originalEnding))
      return textResult(`Successfully replaced ${edits.length} block(s) in ${path}.`)
    },
  }
}

/**
 * Build the four browser coding tools (bash/read/write/edit) bound to `env` and
 * rooted at `options.cwd`. Returned as plain {@link AgentTool}s ready to register
 * on an {@link import('@earendil-works/pi-agent-core').AgentHarness}.
 *
 * @param env - the ZenFS-backed execution environment the tools operate over
 * @param options - `cwd` the tools resolve relative paths against
 */
export const createBrowserCodingTools = (env: BrowserExecutionEnv, options: { cwd: string }): AgentTool[] => {
  const { cwd } = options
  return [buildBashTool(env, cwd), buildReadTool(cwd), buildWriteTool(cwd), buildEditTool(cwd)]
}
