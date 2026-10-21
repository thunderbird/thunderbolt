/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { NativeExecutionEnv, type NativeInvoke } from './native-execution-env'
import { createCodingTools } from './coding-tools'

/** Records native IPC without giving a unit-test model access to the host. */
const bridge = (respond: (command: string, args: Record<string, unknown>) => unknown) => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = []
  const invoke: NativeInvoke = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args })
    return (await respond(command, args)) as T
  }
  return { calls, invoke }
}

describe('native coding environment', () => {
  it('routes read, write and edit through the same native filesystem', async () => {
    const files = new Map<string, number[]>()
    const { invoke, calls } = bridge((_command, args) => {
      if (args.operation === 'resolve') {
        return `/real/${args.path}`
      }
      if (args.operation === 'write') {
        files.set(args.path as string, args.content as number[])
        return
      }
      if (args.operation === 'read') {
        return files.get(args.path as string)
      }
      throw new Error('Unexpected operation')
    })
    const env = new NativeExecutionEnv('/real', invoke)
    const [, read, write, edit] = createCodingTools(env, { cwd: '/real' })
    await write.execute('write', { path: 'file.txt', content: 'first' })
    await edit.execute('edit', { path: 'file.txt', edits: [{ oldText: 'first', newText: 'second' }] })
    const result = await read.execute('read', { path: 'file.txt' })
    expect(result.content).toEqual([{ type: 'text', text: 'second' }])
    expect(calls.every(({ command }) => command === 'agent_fs')).toBe(true)
    expect(calls.filter(({ args }) => args.operation === 'read')).toHaveLength(2)
  })

  it('cancels a command even when Stop arrives while registration is pending', async () => {
    const prepared = Promise.withResolvers<void>()
    const controller = new AbortController()
    const { calls, invoke } = bridge((command) => {
      if (command === 'agent_prepare_command') {
        return prepared.promise
      }
      if (command === 'agent_exec') {
        return { stdout: 'partial', stderr: '', exitCode: -1, failure: 'aborted' }
      }
    })
    const env = new NativeExecutionEnv('/real', invoke)
    const result = env.exec('sleep 60', { abortSignal: controller.signal })
    controller.abort()
    prepared.resolve()
    expect(await result).toMatchObject({ ok: false, error: { code: 'aborted' } })
    expect(calls.map(({ command }) => command)).toEqual(['agent_prepare_command', 'agent_forget_command'])
  })

  it('forwards Stop to an executing command and cleans up its registration', async () => {
    const started = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<unknown>()
    const controller = new AbortController()
    const { calls, invoke } = bridge((command) => {
      if (command === 'agent_exec') {
        started.resolve()
        return completed.promise
      }
      if (command === 'agent_cancel_command') {
        completed.resolve({ stdout: '', stderr: '', exitCode: -1, failure: 'aborted' })
      }
    })
    const result = new NativeExecutionEnv('/real', invoke).exec('sleep 60', { abortSignal: controller.signal })
    await started.promise
    controller.abort()
    expect(await result).toMatchObject({ ok: false, error: { code: 'aborted' } })
    expect(calls.map(({ command }) => command)).toEqual([
      'agent_prepare_command',
      'agent_exec',
      'agent_cancel_command',
      'agent_forget_command',
    ])
    expect(new Set(calls.map(({ args }) => args.id)).size).toBe(1)
  })

  it('forwards partial output on timeout and encodes IPC failures as Results', async () => {
    const chunks: string[] = []
    const { invoke } = bridge((command) => {
      if (command === 'agent_exec') {
        return { stdout: 'partial', stderr: 'error', exitCode: -1, failure: 'timeout' }
      }
      if (command === 'agent_fs') {
        throw new Error('Permission denied')
      }
    })
    const env = new NativeExecutionEnv('/real', invoke)
    const result = await env.exec('sleep 60', {
      timeout: 2,
      onStdout: (text) => chunks.push(text),
      onStderr: (text) => chunks.push(text),
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'timeout', message: 'timeout:2' } })
    expect(chunks).toEqual(['partial', 'error'])
    expect(await env.readBinaryFile('secret')).toMatchObject({ ok: false })
  })
})
