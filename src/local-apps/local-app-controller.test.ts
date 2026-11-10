/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from 'bun:test'
import type { LocalAppStatus } from '@shared/local-app-protocol'
import { createLocalAppController } from './local-app-controller'
import { listLocalApps, useLocalAppStore } from './local-app-store'

const project = { kind: 'project', id: 'project-one' } as const
const input = {
  owner: project,
  title: ' My app ',
  cwd: '/tmp/project',
  launch: { executable: 'bun', args: ['run', 'dev', '--port', '{port}', '--host', '127.0.0.1'] },
}

const fixture = () => {
  const calls: { command: string; args: Record<string, unknown> }[] = []
  let state: LocalAppStatus | null = null
  const native = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args })
    const id = String(args.id ?? (args.request as { id: string } | undefined)?.id)
    if (command === 'agent_preview_start') {
      state = { id, status: 'ready', url: 'http://127.0.0.1:4179/', error: null, logs: 'ready' }
    }
    if (command === 'agent_preview_stop') {
      state = { id, status: 'stopped', url: null, error: null, logs: '' }
    }
    return state as T
  }
  return { controller: createLocalAppController(native, () => true), calls }
}

beforeEach(() => useLocalAppStore.setState({ apps: {} }))

describe('local app lifecycle', () => {
  it('stores project and standalone recipes locally without ephemeral URLs', () => {
    const { controller } = fixture()
    const app = controller.create(input)
    controller.create({ ...input, owner: { kind: 'chat', id: 'standalone' } })
    expect(listLocalApps(project)).toEqual([app])
    expect(app.title).toBe('My app')
    expect(app).not.toHaveProperty('url')
    expect(app.launch.args).toContain('{port}')
  })

  it('reuses a running app and restarts only when explicitly requested', async () => {
    const { controller, calls } = fixture()
    const app = controller.create(input)
    const first = await controller.start(app.id)
    const second = await controller.start(app.id)
    expect(second.url).toBe(first.url)
    expect(calls.filter((call) => call.command === 'agent_preview_start')).toHaveLength(1)
    await controller.restart(app.id)
    expect(calls.filter((call) => call.command === 'agent_preview_start')).toHaveLength(2)
    expect(calls.find((call) => call.command === 'agent_preview_start')?.args).toEqual({
      request: { id: app.id, cwd: input.cwd, ...input.launch },
    })
  })

  it('does not execute a start that was already cancelled', async () => {
    const { controller, calls } = fixture()
    const app = controller.create(input)
    await expect(controller.start(app.id, AbortSignal.abort())).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('cancels a new startup without leaving an unseen server running', async () => {
    const abort = new AbortController()
    const calls: string[] = []
    const native = async <T>(command: string): Promise<T> => {
      calls.push(command)
      if (command === 'agent_preview_start') {
        abort.abort()
        return { status: 'starting' } as T
      }
      return null as T
    }
    const controller = createLocalAppController(native, () => true)
    const app = controller.create(input)
    await expect(controller.start(app.id, abort.signal)).rejects.toThrow()
    expect(calls).toEqual(['agent_preview_status', 'agent_preview_start', 'agent_preview_stop'])
  })

  it('shares startup across callers and one cancelled waiter cannot stop the other', async () => {
    let finish: ((status: LocalAppStatus) => void) | undefined
    const commands: string[] = []
    let started!: () => void
    const starting = new Promise<void>((resolve) => {
      started = resolve
    })
    const native = async <T>(command: string): Promise<T> => {
      commands.push(command)
      if (command === 'agent_preview_start') {
        return new Promise<LocalAppStatus>((resolve) => {
          finish = resolve
          started()
        }) as Promise<T>
      }
      return null as T
    }
    const controller = createLocalAppController(native, () => true)
    const app = controller.create(input)
    const abort = new AbortController()
    const first = controller.start(app.id, abort.signal)
    const firstCancelled = first.catch((error) => error)
    // This is the StrictMode setup/cleanup/setup sequence in one React commit.
    abort.abort()
    const second = controller.start(app.id)
    await starting
    expect(commands.filter((command) => command === 'agent_preview_start')).toHaveLength(1)
    finish!({ id: app.id, status: 'ready', url: 'http://127.0.0.1:4001/', error: null, logs: '' })
    expect(await firstCancelled).toBeInstanceOf(Error)
    expect((await second).url).toBe('http://127.0.0.1:4001/')
    expect(commands).not.toContain('agent_preview_stop')
  })

  it('stops and soft deletes recipes without deleting workspace files', async () => {
    const { controller, calls } = fixture()
    const app = controller.create(input)
    await controller.remove(app.id)
    expect(controller.get(app.id)).toBeUndefined()
    expect(useLocalAppStore.getState().apps[app.id]?.deletedAt).toBeDefined()
    expect(calls.map((call) => call.command)).toEqual(['agent_preview_stop'])
  })

  it('rejects web/mobile execution and unavailable device-local bindings', async () => {
    const controller = createLocalAppController(
      async () => {
        throw new Error('IPC must not run')
      },
      () => false,
    )
    expect(() => controller.create(input)).toThrow('desktop')
    await expect(controller.start('missing')).rejects.toThrow('desktop')
    await expect(fixture().controller.start('missing')).rejects.toThrow('not available on this device')
  })
})
