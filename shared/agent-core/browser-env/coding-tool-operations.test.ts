/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the browser coding-tool operation adapters.
 *
 * `createBashOperations` is tested with a hand-written fake `BrowserExecutionEnv`
 * (dependency injection, not module mocking): it is the boundary translation
 * between the env's never-throw `Result` and Pi's bash tool, which decodes
 * failures from a *thrown* error. The translation (success -> exitCode, failure
 * -> re-throw the typed error, stdout+stderr -> a single `onData` Buffer stream)
 * is the only real logic in this file and the part most likely to regress.
 *
 * The read/write/edit adapters are thin ZenFS wrappers, so they run against a
 * real in-memory mount (the shared singleton) to prove the Buffer conversion and
 * recursive-mkdir behavior the coding tools rely on.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { ExecutionError, err, ok, type Result } from '@earendil-works/pi-agent-core'
import * as fsp from '@zenfs/core/promises'
import type { BrowserExecutionEnv } from './browser-execution-env.ts'
import {
  createBashOperations,
  createEditOperations,
  createReadOperations,
  createWriteOperations,
} from './coding-tool-operations.ts'
import { mountInMemoryFs } from './mount.ts'

type ExecResult = Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>

/** Minimal fake env that records the options it was called with and lets each
 *  test script the exec outcome + what gets streamed. Only `exec` is exercised. */
const fakeEnv = (script: {
  result: ExecResult
  emit?: { stdout?: string; stderr?: string }
}): { env: BrowserExecutionEnv; calls: Array<{ command: string; options: Record<string, unknown> }> } => {
  const calls: Array<{ command: string; options: Record<string, unknown> }> = []
  const env = {
    exec: async (command: string, options: Record<string, unknown>) => {
      calls.push({ command, options })
      if (script.emit?.stdout !== undefined) (options.onStdout as (c: string) => void)(script.emit.stdout)
      if (script.emit?.stderr !== undefined) (options.onStderr as (c: string) => void)(script.emit.stderr)
      return script.result
    },
  } as unknown as BrowserExecutionEnv
  return { env, calls }
}

describe('createBashOperations', () => {
  it('returns the env exitCode on success', async () => {
    const { env } = fakeEnv({ result: ok({ stdout: '', stderr: '', exitCode: 7 }) })
    const ops = createBashOperations(env)
    const result = await ops.exec('echo hi', '/workspace/t1', { onData: () => {} })
    expect(result).toEqual({ exitCode: 7 })
  })

  it('streams BOTH stdout and stderr through onData as Buffers', async () => {
    const { env } = fakeEnv({
      result: ok({ stdout: '', stderr: '', exitCode: 0 }),
      emit: { stdout: 'out-chunk', stderr: 'err-chunk' },
    })
    const ops = createBashOperations(env)
    const chunks: Buffer[] = []
    await ops.exec('cmd', '/workspace/t1', { onData: (d) => chunks.push(d) })
    expect(chunks.every((c) => Buffer.isBuffer(c))).toBe(true)
    expect(chunks.map((c) => c.toString())).toEqual(['out-chunk', 'err-chunk'])
  })

  it('re-throws the env ExecutionError on failure, after still streaming any output emitted before it', async () => {
    const timeoutError = new ExecutionError('timeout', 'timeout:5')
    // Output produced before the command timed out must reach the tool, and the
    // exact same error instance must surface — its `.message` carries the framing
    // the bash tool parses; re-wrapping would break timeout detection.
    const { env } = fakeEnv({ result: err(timeoutError), emit: { stdout: 'partial-before-timeout' } })
    const ops = createBashOperations(env)
    const chunks: Buffer[] = []
    await expect(ops.exec('sleep 10', '/workspace/t1', { onData: (d) => chunks.push(d) })).rejects.toBe(timeoutError)
    expect(chunks.map((c) => c.toString())).toEqual(['partial-before-timeout'])
  })

  it('forwards cwd, timeout and the abort signal into env.exec', async () => {
    const { env, calls } = fakeEnv({ result: ok({ stdout: '', stderr: '', exitCode: 0 }) })
    const ops = createBashOperations(env)
    const signal = new AbortController().signal
    await ops.exec('cmd', '/workspace/sub', { onData: () => {}, signal, timeout: 12 })
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('cmd')
    expect(calls[0].options.cwd).toBe('/workspace/sub')
    expect(calls[0].options.timeout).toBe(12)
    expect(calls[0].options.abortSignal).toBe(signal)
  })
})

const DIR = '/optest'

describe('file operation adapters (real in-memory ZenFS)', () => {
  beforeAll(async () => {
    await mountInMemoryFs()
    await fsp.mkdir(DIR, { recursive: true })
    await fsp.writeFile(`${DIR}/seed.txt`, 'seed-content')
  })

  afterAll(async () => {
    await fsp.rm(DIR, { recursive: true, force: true })
  })

  it('readFile returns a Node Buffer (not a bare Uint8Array)', async () => {
    const ops = createReadOperations()
    const buf = await ops.readFile(`${DIR}/seed.txt`)
    // The operation contract is typed in terms of Buffer; ZenFS hands back a
    // Uint8Array, so the Buffer.from wrap is load-bearing for callers doing
    // Buffer-only ops (.toString('utf8'), slicing).
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.toString('utf8')).toBe('seed-content')
  })

  it('access resolves for an existing file and rejects (ENOENT) for a missing one', async () => {
    const ops = createReadOperations()
    await expect(ops.access(`${DIR}/seed.txt`)).resolves.toBeUndefined()
    // The edit tool branches on this rejection to distinguish edit vs create.
    await expect(ops.access(`${DIR}/missing.txt`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('write mkdir creates nested dirs recursively; the file is then visible to the read adapter (shared mount)', async () => {
    const writeOps = createWriteOperations()
    await writeOps.mkdir(`${DIR}/deep/nested`)
    await writeOps.writeFile(`${DIR}/deep/nested/out.txt`, 'written')
    // Read back through a SEPARATE adapter to prove both target the one ZenFS
    // singleton, not via raw fsp (which would prove nothing about the adapters).
    const readOps = createReadOperations()
    expect((await readOps.readFile(`${DIR}/deep/nested/out.txt`)).toString('utf8')).toBe('written')
  })

  it('edit writeFile overwrites in place and readFile reads the new content back as a Buffer', async () => {
    const ops = createEditOperations()
    const target = `${DIR}/edit-target.txt`
    await ops.writeFile(target, 'v1')
    await ops.writeFile(target, 'v2-overwritten')
    const buf = await ops.readFile(target)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.toString('utf8')).toBe('v2-overwritten')
  })

  it('edit access rejects for a missing file (the create-vs-edit signal)', async () => {
    const ops = createEditOperations()
    await expect(ops.access(`${DIR}/never-existed.txt`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
