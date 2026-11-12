/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { createCodingTools } from './coding-tools'
import { SshExecutionEnv } from './ssh-execution-env'
import { invokeSshRequest, type SshConnection, type SshRequest } from './ssh-transport'
import type { NativeInvoke } from './native-execution-env'

const connection: SshConnection = {
  environmentId: 'ssh-environment',
  host: 'orb',
  username: 'chris@ubuntu',
  authentication: 'agent',
}

const bridge = (reply: (request: SshRequest) => unknown) => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = []
  const invoke: NativeInvoke = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args })
    return (command === 'agent_ssh_request' ? await reply(args.request as SshRequest) : undefined) as T
  }
  return { invoke, calls }
}

it('runs real read/write/edit tools entirely through the saved SSH connection', async () => {
  const files = new Map<string, number[]>()
  const { invoke, calls } = bridge((request) => {
    switch (request.operation) {
      case 'resolve':
        return `/remote/${request.path}`
      case 'read':
        return files.get(request.path!)
      case 'write':
        files.set(request.path!, request.content!)
        return
      default:
        throw new Error('Unexpected request')
    }
  })
  const environment = new SshExecutionEnv('/remote', connection, invoke, 'owner')
  const [, read, write, edit] = createCodingTools(environment, { cwd: '/remote' })
  await write.execute('write', { path: 'test.txt', content: 'one' })
  await edit.execute('edit', { path: 'test.txt', edits: [{ oldText: 'one', newText: 'two' }] })
  expect((await read.execute('read', { path: 'test.txt' })).content).toEqual([{ type: 'text', text: 'two' }])
  const requests = calls.filter(({ command }) => command === 'agent_ssh_request')
  expect(requests.length).toBeGreaterThan(0)
  for (const { args } of requests) {
    expect(args.connection).toEqual(connection)
    expect(args.request).toMatchObject({ cwd: '/remote', owner: 'owner' })
  }
  expect(calls.some(({ command }) => command === 'agent_fs' || command === 'agent_exec')).toBe(false)
})

it('restores binary attachments without overwriting and cleans only its remote output owner', async () => {
  const { invoke, calls } = bridge((request) => (request.operation === 'temp' ? '/tmp/owned.log' : undefined))
  const environment = new SshExecutionEnv('~/work', connection, invoke, 'same-owner')
  expect((await environment.restoreFile('attached.bin', new Uint8Array([0, 255]))).ok).toBe(true)
  expect(await environment.createTempFile({ prefix: 'pi-', suffix: '.log' })).toEqual({
    ok: true,
    value: '/tmp/owned.log',
  })
  await environment.cleanup()
  expect(calls.filter(({ command }) => command === 'agent_ssh_request').map(({ args }) => args.request)).toEqual([
    { cwd: '~/work', owner: 'same-owner', operation: 'restore', path: 'attached.bin', content: [0, 255] },
    { cwd: '~/work', owner: 'same-owner', operation: 'temp', prefix: 'pi-', suffix: '.log' },
    { cwd: '~/work', owner: 'same-owner', operation: 'cleanup' },
  ])
})

it('preserves shell output and nonzero exit status, forwarding cwd/env/deadlines without local shell interpolation', async () => {
  const output = { stdout: 'hello', stderr: 'warning', exitCode: 3 }
  const { invoke, calls } = bridge(() => output)
  const environment = new SshExecutionEnv('/remote', connection, invoke)
  const chunks: string[] = []
  expect(
    await environment.exec('printf "$NAME"', {
      cwd: '/remote/space dir',
      env: { NAME: 'a; $(touch /tmp/no)' },
      timeout: 2,
      onStdout: (value) => chunks.push(value),
      onStderr: (value) => chunks.push(value),
    }),
  ).toEqual({ ok: true, value: output })
  expect(chunks).toEqual(['hello', 'warning'])
  expect(calls.find(({ command }) => command === 'agent_ssh_request')?.args.request).toMatchObject({
    cwd: '/remote/space dir',
    env: { NAME: 'a; $(touch /tmp/no)' },
    timeout: 2,
    command: 'printf "$NAME"',
  })
})

it('does not start SSH if Stop arrives while registration is pending', async () => {
  const registered = Promise.withResolvers<void>()
  const calls: string[] = []
  const invoke: NativeInvoke = async <T>(command: string) => {
    calls.push(command)
    if (command === 'agent_prepare_command') {
      await registered.promise
    }
    return undefined as T
  }
  const controller = new AbortController()
  const operation = new SshExecutionEnv('/remote', connection, invoke).exec('touch file', {
    abortSignal: controller.signal,
  })
  controller.abort()
  registered.resolve()
  expect(await operation).toMatchObject({ ok: false, error: { code: 'aborted' } })
  expect(calls).toEqual(['agent_prepare_command', 'agent_forget_command'])
})

it.each(['exec', 'read'] as const)('cancels an in-flight %s and always removes the registration', async (operation) => {
  const started = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const calls: Array<{ command: string; id: unknown }> = []
  const invoke: NativeInvoke = async <T>(command: string, args: Record<string, unknown>) => {
    calls.push({ command, id: args.id })
    if (command === 'agent_ssh_request') {
      started.resolve()
      await finished.promise
      throw new Error('aborted')
    }
    if (command === 'agent_cancel_command') {
      finished.resolve()
    }
    return undefined as T
  }
  const controller = new AbortController()
  const environment = new SshExecutionEnv('/remote', connection, invoke)
  const result =
    operation === 'exec'
      ? environment.exec('sleep 60', { abortSignal: controller.signal })
      : environment.readBinaryFile('large-file', controller.signal)
  await started.promise
  controller.abort()
  expect(await result).toMatchObject({ ok: false, error: { code: 'aborted' } })
  expect(calls.map(({ command }) => command)).toEqual([
    'agent_prepare_command',
    'agent_ssh_request',
    'agent_cancel_command',
    'agent_forget_command',
  ])
  expect(new Set(calls.map(({ id }) => id)).size).toBe(1)
})

it('does not retry transport failures with uncertain side effects', async () => {
  const { invoke, calls } = bridge(() => {
    throw new Error('Connection lost')
  })
  expect(await new SshExecutionEnv('/remote', connection, invoke).exec('increment-counter')).toMatchObject({
    ok: false,
    error: { code: 'unknown', message: 'Error: Connection lost' },
  })
  expect(calls.filter(({ command }) => command === 'agent_ssh_request')).toHaveLength(1)
})

it('forwards partial output before reporting a remote timeout', async () => {
  const { invoke } = bridge(() => ({ stdout: 'partial', stderr: '', exitCode: -1, failure: 'timeout' }))
  const chunks: string[] = []
  expect(
    await new SshExecutionEnv('/remote', connection, invoke).exec('sleep 60', {
      timeout: 1,
      onStdout: (text) => chunks.push(text),
    }),
  ).toMatchObject({ ok: false, error: { code: 'timeout' } })
  expect(chunks).toEqual(['partial'])
})

it('never registers an already-cancelled request', async () => {
  const { invoke, calls } = bridge(() => undefined)
  await expect(
    invokeSshRequest(invoke, connection, { operation: 'probe', cwd: '~', owner: 'owner' }, AbortSignal.abort()),
  ).rejects.toThrow()
  expect(calls).toEqual([])
})
