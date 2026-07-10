/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for the four browser coding tools' wiring: argument preparation/validation,
 * error/abort paths, and output shaping (continuation hints, truncation footers,
 * line-ending/BOM preservation). Driven through the public `createBrowserCodingTools`
 * factory over a real in-memory ZenFS mount (DI of the FS via the mount, not module
 * mocking) so the tests exercise the genuine tool → operation → ZenFS path. The pure
 * edit MATCHING algorithm is covered separately in `edit-apply.test.ts`; here we only
 * cover the edit tool's wiring (prepareArguments, validation, BOM/CRLF round-trip,
 * error path) without duplicating it.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fsp from '@zenfs/core/promises'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { mountInMemoryFs } from '../browser-env/mount.ts'
import { BrowserExecutionEnv } from '../browser-env/browser-execution-env.ts'
import { createBrowserCodingTools } from './index.ts'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from './truncate.ts'

const WS = '/ws'

const textOf = (result: { content: { type: string; text?: string }[] }): string => {
  const block = result.content[0]
  if (block.type !== 'text' || block.text === undefined) throw new Error('expected a text block')
  return block.text
}

let bash: AgentTool
let read: AgentTool
let write: AgentTool
let edit: AgentTool

beforeAll(async () => {
  await mountInMemoryFs()
})

beforeEach(async () => {
  // Fresh workspace per test so files from one test can't leak into another.
  await fsp.rm(WS, { recursive: true, force: true })
  await fsp.mkdir(WS, { recursive: true })
  const env = new BrowserExecutionEnv({ cwd: WS })
  ;[bash, read, write, edit] = createBrowserCodingTools(env, { cwd: WS })
})

const run = (tool: AgentTool, args: unknown) =>
  // The Pi AgentTool.execute signature: (toolCallId, args, signal).
  (tool.execute as (id: string, a: unknown, s?: AbortSignal) => Promise<{ content: { type: string; text?: string }[] }>)(
    'call-1',
    args,
    undefined,
  )

describe('createBrowserCodingTools', () => {
  it('exposes the four tools in order with the model-visible names', () => {
    expect([bash.name, read.name, write.name, edit.name]).toEqual(['bash', 'read', 'write', 'edit'])
    // The mutating tools serialize the batch; read does not.
    expect(bash.executionMode).toBe('sequential')
    expect(write.executionMode).toBe('sequential')
    expect(edit.executionMode).toBe('sequential')
    expect(read.executionMode).toBeUndefined()
  })
})

describe('read tool', () => {
  it('returns the full file content when small', async () => {
    await fsp.writeFile(`${WS}/a.txt`, 'line one\nline two')
    expect(textOf(await run(read, { path: 'a.txt' }))).toBe('line one\nline two')
  })

  it('applies offset + limit and appends a continuation hint with the next offset', async () => {
    await fsp.writeFile(`${WS}/f.txt`, 'l1\nl2\nl3\nl4\nl5')
    const out = textOf(await run(read, { path: 'f.txt', offset: 2, limit: 2 }))
    expect(out).toBe('l2\nl3\n\n[2 more lines in file. Use offset=4 to continue.]')
  })

  it('does not append a continuation hint when the limit reaches end of file', async () => {
    await fsp.writeFile(`${WS}/f.txt`, 'l1\nl2\nl3')
    expect(textOf(await run(read, { path: 'f.txt', offset: 1, limit: 3 }))).toBe('l1\nl2\nl3')
  })

  it('counts a trailing newline as a line (unlike truncate.ts, which drops it)', async () => {
    // 'a\nb\n' splits into ['a','b',''] here, so the empty trailing entry is a 3rd line.
    await fsp.writeFile(`${WS}/f.txt`, 'a\nb\n')
    expect(textOf(await run(read, { path: 'f.txt', offset: 1, limit: 1 }))).toBe(
      'a\n\n[2 more lines in file. Use offset=2 to continue.]',
    )
  })

  it('clamps a negative offset to the start of the file', async () => {
    await fsp.writeFile(`${WS}/f.txt`, 'l1\nl2\nl3')
    expect(textOf(await run(read, { path: 'f.txt', offset: -5, limit: 1 }))).toBe(
      'l1\n\n[2 more lines in file. Use offset=2 to continue.]',
    )
  })

  it('handles limit=0 (selects no lines) and still reports the remaining count', async () => {
    await fsp.writeFile(`${WS}/f.txt`, 'l1\nl2\nl3')
    expect(textOf(await run(read, { path: 'f.txt', offset: 1, limit: 0 }))).toBe(
      '\n\n[3 more lines in file. Use offset=1 to continue.]',
    )
  })

  it('throws when the offset is beyond end of file', async () => {
    await fsp.writeFile(`${WS}/f.txt`, 'only\ntwo')
    await expect(run(read, { path: 'f.txt', offset: 10 })).rejects.toThrow(
      'Offset 10 is beyond end of file (2 lines total)',
    )
  })

  it('head-truncates very long files and emits a line-based continuation footer', async () => {
    const content = Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, i) => `row${i}`).join('\n')
    await fsp.writeFile(`${WS}/big.txt`, content)
    const out = textOf(await run(read, { path: 'big.txt' }))
    expect(out).toContain(`[Showing lines 1-${DEFAULT_MAX_LINES} of ${DEFAULT_MAX_LINES + 1}. Use offset=${DEFAULT_MAX_LINES + 1} to continue.]`)
    expect(out).not.toContain('limit)') // line-based truncation has no "(50.0KB limit)" note
  })

  it('byte-truncates a many-line file and appends the "(50.0KB limit)" footer', async () => {
    // 100 lines × ~600 bytes = ~60KB: under the 2000-line limit but over the 50KB
    // byte limit, so truncation is byte-based and the footer carries the limit note.
    const content = Array.from({ length: 100 }, (_, i) => `${i}:${'y'.repeat(600)}`).join('\n')
    await fsp.writeFile(`${WS}/wide.txt`, content)
    const out = textOf(await run(read, { path: 'wide.txt' }))
    expect(out).toContain('(50.0KB limit). Use offset=')
    expect(out.startsWith('0:')).toBe(true) // head truncation keeps the FIRST lines
  })

  it('shifts the displayed line numbers and next offset when reading from an offset into a truncated region', async () => {
    const content = Array.from({ length: DEFAULT_MAX_LINES + 10 }, (_, i) => `row${i}`).join('\n')
    await fsp.writeFile(`${WS}/big.txt`, content)
    const out = textOf(await run(read, { path: 'big.txt', offset: 5 }))
    // From offset 5, the kept window is DEFAULT_MAX_LINES lines: 5 .. 5+2000-1 = 2004.
    expect(out).toContain(
      `[Showing lines 5-${5 + DEFAULT_MAX_LINES - 1} of ${DEFAULT_MAX_LINES + 10}. Use offset=${5 + DEFAULT_MAX_LINES} to continue.]`,
    )
  })

  it('returns the sed escape hint (no content) when a single line exceeds the byte limit', async () => {
    await fsp.writeFile(`${WS}/wide.txt`, 'x'.repeat(60 * 1024))
    const out = textOf(await run(read, { path: 'wide.txt' }))
    expect(out).toContain('[Line 1 is 60.0KB, exceeds 50.0KB limit.')
    expect(out).toContain("sed -n '1p' wide.txt | head -c " + DEFAULT_MAX_BYTES)
  })

  it('rejects an absolute path that escapes the workspace jail', async () => {
    await expect(run(read, { path: '/etc/passwd' })).rejects.toThrow('path escapes workspace')
  })

  it('rejects a `..` traversal that escapes the workspace jail', async () => {
    await expect(run(read, { path: '../secret.txt' })).rejects.toThrow('path escapes workspace')
  })

  it('aborts before touching the filesystem when the signal is already aborted', async () => {
    // Target a MISSING file: if access() ran despite the aborted signal we would see
    // ENOENT, so the 'Operation aborted' message proves the abort short-circuits first.
    const aborted = AbortSignal.abort()
    await expect(
      (read.execute as (id: string, a: unknown, s?: AbortSignal) => Promise<unknown>)(
        'c',
        { path: 'never-created.txt' },
        aborted,
      ),
    ).rejects.toThrow('Operation aborted')
  })
})

describe('write tool', () => {
  it('writes content and reports the UTF-8 byte count and path', async () => {
    const out = textOf(await run(write, { path: 'out.txt', content: 'hello' }))
    expect(out).toBe('Successfully wrote 5 bytes to out.txt')
    expect(await fsp.readFile(`${WS}/out.txt`, { encoding: 'utf8' })).toBe('hello')
  })

  it('reports the UTF-8 byte length for multibyte content', async () => {
    const out = textOf(await run(write, { path: 'mb.txt', content: '€€' }))
    expect(out).toBe('Successfully wrote 6 bytes to mb.txt')
    expect(Buffer.byteLength(await fsp.readFile(`${WS}/mb.txt`, { encoding: 'utf8' }), 'utf-8')).toBe(6)
  })

  it('creates missing parent directories', async () => {
    await run(write, { path: 'nested/deep/file.txt', content: 'x' })
    expect(await fsp.readFile(`${WS}/nested/deep/file.txt`, { encoding: 'utf8' })).toBe('x')
  })

  it('overwrites an existing file', async () => {
    await fsp.writeFile(`${WS}/o.txt`, 'old')
    await run(write, { path: 'o.txt', content: 'new' })
    expect(await fsp.readFile(`${WS}/o.txt`, { encoding: 'utf8' })).toBe('new')
  })

  it('rejects writing outside the workspace jail', async () => {
    await expect(run(write, { path: '../escape.txt', content: 'x' })).rejects.toThrow('path escapes workspace')
  })
})

describe('edit tool – argument preparation', () => {
  const prepare = (input: unknown): unknown =>
    (edit.prepareArguments as (i: unknown) => unknown)(input)

  it('parses a JSON-string `edits` into an array (some models stringify it)', () => {
    expect(prepare({ path: 'f', edits: '[{"oldText":"a","newText":"b"}]' })).toEqual({
      path: 'f',
      edits: [{ oldText: 'a', newText: 'b' }],
    })
  })

  it('folds a top-level oldText/newText pair into edits[] and strips the legacy keys', () => {
    expect(prepare({ path: 'f', oldText: 'a', newText: 'b' })).toEqual({
      path: 'f',
      edits: [{ oldText: 'a', newText: 'b' }],
    })
  })

  it('appends a top-level oldText/newText pair to an existing edits[] array', () => {
    expect(
      prepare({ path: 'f', edits: [{ oldText: 'x', newText: 'y' }], oldText: 'a', newText: 'b' }),
    ).toEqual({ path: 'f', edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'a', newText: 'b' }] })
  })

  it('leaves a non-JSON `edits` string untouched so validation surfaces a clear error', () => {
    expect(prepare({ path: 'f', edits: 'not json' })).toEqual({ path: 'f', edits: 'not json' })
  })

  it('passes non-object input through unchanged', () => {
    expect(prepare(null)).toBeNull()
    expect(prepare('raw')).toBe('raw')
  })
})

describe('edit tool – execution', () => {
  it('throws when no replacements are provided', async () => {
    await fsp.writeFile(`${WS}/f.txt`, 'abc')
    await expect(run(edit, { path: 'f.txt', edits: [] })).rejects.toThrow(
      'edits must contain at least one replacement',
    )
  })

  it('reports a friendly error (with the FS error code) when the file does not exist', async () => {
    await expect(run(edit, { path: 'missing.txt', edits: [{ oldText: 'a', newText: 'b' }] })).rejects.toThrow(
      /Could not edit file: missing\.txt\..*ENOENT/,
    )
  })

  it('rejects editing outside the workspace jail', async () => {
    await expect(run(edit, { path: '../escape.txt', edits: [{ oldText: 'a', newText: 'b' }] })).rejects.toThrow(
      'path escapes workspace',
    )
  })

  it('propagates a match failure and leaves the file unchanged when oldText is absent', async () => {
    await fsp.writeFile(`${WS}/f.txt`, 'hello world')
    await expect(run(edit, { path: 'f.txt', edits: [{ oldText: 'zzz', newText: 'q' }] })).rejects.toThrow()
    expect(await fsp.readFile(`${WS}/f.txt`, { encoding: 'utf8' })).toBe('hello world')
  })

  it('composes prepareArguments with execute (stringified edits applied end-to-end)', async () => {
    await fsp.writeFile(`${WS}/f.txt`, 'hello world')
    const prepared = (edit.prepareArguments as (i: unknown) => unknown)({
      path: 'f.txt',
      edits: '[{"oldText":"world","newText":"pi"}]',
    })
    expect(textOf(await run(edit, prepared))).toBe('Successfully replaced 1 block(s) in f.txt.')
    expect(await fsp.readFile(`${WS}/f.txt`, { encoding: 'utf8' })).toBe('hello pi')
  })

  it('applies a replacement and reports the block count', async () => {
    await fsp.writeFile(`${WS}/f.txt`, 'hello world')
    const out = textOf(await run(edit, { path: 'f.txt', edits: [{ oldText: 'world', newText: 'pi' }] }))
    expect(out).toBe('Successfully replaced 1 block(s) in f.txt.')
    expect(await fsp.readFile(`${WS}/f.txt`, { encoding: 'utf8' })).toBe('hello pi')
  })

  it('preserves CRLF line endings across the edit', async () => {
    await fsp.writeFile(`${WS}/crlf.txt`, 'a\r\nb\r\nc')
    await run(edit, { path: 'crlf.txt', edits: [{ oldText: 'b', newText: 'B' }] })
    expect(await fsp.readFile(`${WS}/crlf.txt`, { encoding: 'utf8' })).toBe('a\r\nB\r\nc')
  })

  it('preserves a leading BOM (U+FEFF) across the edit', async () => {
    await fsp.writeFile(`${WS}/bom.txt`, '\uFEFFhello')
    await run(edit, { path: 'bom.txt', edits: [{ oldText: 'hello', newText: 'bye' }] })
    expect(await fsp.readFile(`${WS}/bom.txt`, { encoding: 'utf8' })).toBe('\uFEFFbye')
  })

  it('reports the count for multiple blocks', async () => {
    await fsp.writeFile(`${WS}/m.txt`, 'a x c')
    const out = textOf(
      await run(edit, { path: 'm.txt', edits: [{ oldText: 'a', newText: 'A' }, { oldText: 'c', newText: 'C' }] }),
    )
    expect(out).toBe('Successfully replaced 2 block(s) in m.txt.')
    expect(await fsp.readFile(`${WS}/m.txt`, { encoding: 'utf8' })).toBe('A x C')
  })
})

describe('bash tool', () => {
  it('returns command stdout', async () => {
    expect(textOf(await run(bash, { command: 'echo hello' }))).toBe('hello\n')
  })

  it('reports "(no output)" when a successful command writes nothing', async () => {
    expect(textOf(await run(bash, { command: 'true' }))).toBe('(no output)')
  })

  it('captures stderr alongside stdout', async () => {
    expect(textOf(await run(bash, { command: 'echo oops >&2' }))).toBe('oops\n')
  })

  it('includes captured output AND the status line when a command prints then exits non-zero', async () => {
    // appendStatus joins the captured stdout with the status via a blank line.
    await expect(run(bash, { command: 'echo partial; exit 3' })).rejects.toThrow(
      /partial[\s\S]*Command exited with code 3/,
    )
  })

  it('throws "Command aborted" (with captured output) when the run is aborted', async () => {
    await expect(
      (bash.execute as (id: string, a: unknown, s?: AbortSignal) => Promise<unknown>)(
        'c',
        { command: 'echo hi' },
        AbortSignal.abort(),
      ),
    ).rejects.toThrow('Command aborted')
  })

  it('byte-truncates output and labels the footer with the 50KB limit', async () => {
    // 60 lines × ~1001 bytes ≈ 60KB: under the line limit but over the byte limit.
    const out = textOf(
      await run(bash, { command: 'for i in $(seq 1 60); do printf "%01000d\\n" $i; done' }),
    )
    expect(out).toContain('(50.0KB limit). Full output:')
  })

  it('truncates long output (tail) and persists the FULL output to the temp file it names', async () => {
    const lineCount = DEFAULT_MAX_LINES + 5
    const out = textOf(await run(bash, { command: `for i in $(seq 1 ${lineCount}); do echo line$i; done` }))
    expect(out).toContain('[Showing lines')
    // Tail truncation keeps the END: the last line is present, an early line is dropped.
    expect(out).toContain(`line${lineCount}`)
    expect(out).not.toContain('line1\n')
    // Parse the persisted path out of the footer and confirm it holds the UNtruncated output.
    const match = out.match(/Full output: (\S+?)\]/)
    expect(match).not.toBeNull()
    const full = await fsp.readFile(match![1], { encoding: 'utf8' })
    expect(full).toContain('line1\n')
    expect(full).toContain(`line${lineCount}\n`)
    expect(full.split('\n').filter(Boolean)).toHaveLength(lineCount)
  })
})
