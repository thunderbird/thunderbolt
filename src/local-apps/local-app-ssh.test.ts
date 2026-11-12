/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { LocalAppStatus } from '@shared/local-app-protocol'
import { getClock } from '@/testing-library'
import { sshConnection, useSshEnvironmentsStore } from '@/agent-execution/ssh-environments'
import { createLocalAppController } from './local-app-controller'
import { useLocalAppStore } from './local-app-store'

const environment = {
  id: crypto.randomUUID(),
  name: 'VM',
  host: 'vm',
  cwd: '/workspace',
  authentication: 'agent' as const,
  deletedAt: null,
}
const connection = sshConnection(environment)
const recipe = {
  owner: { kind: 'project' as const, id: 'ssh-project' },
  title: 'Remote app',
  cwd: '/workspace',
  connection,
  launch: { executable: '/home/user/.bun/bin/bun', args: ['run', 'dev', '--port', '{port}'] },
}
const status = (id: string, state: LocalAppStatus['status']): LocalAppStatus => ({
  id,
  status: state,
  url: state === 'ready' ? 'http://127.0.0.1:48500/' : null,
  error: null,
  logs: '',
})

beforeEach(() => {
  useLocalAppStore.setState({ apps: {} })
  useSshEnvironmentsStore.setState({ environments: { [environment.id]: environment }, connectionStatuses: {} })
})
afterEach(() => {
  useLocalAppStore.setState({ apps: {} })
  useSshEnvironmentsStore.setState({ environments: {}, connectionStatuses: {} })
})

const fixture = () => {
  const calls: { command: string; args: Record<string, unknown> }[] = []
  const native = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args })
    const id = String(args.id ?? (args.request as { id: string } | undefined)?.id)
    return (command === 'agent_preview_start' ? status(id, 'ready') : null) as T
  }
  return { controller: createLocalAppController(native, () => true), calls }
}

describe('managed SSH apps', () => {
  it('sends the exact saved connection and remote argv but returns the forwarded desktop URL', async () => {
    const { controller, calls } = fixture()
    const app = controller.create(recipe)
    expect((await controller.start(app.id)).url).toBe('http://127.0.0.1:48500/')
    expect(calls.at(-1)).toEqual({
      command: 'agent_preview_start',
      args: { request: { id: app.id, cwd: recipe.cwd, ...recipe.launch, connection } },
    })
    expect(controller.get(app.id)).not.toHaveProperty('url')
    expect(useSshEnvironmentsStore.getState().connectionStatuses[environment.id]?.status).toBe('connected')
  })

  it('accepts equivalent saved connection fields in a different JSON order', async () => {
    const { controller } = fixture()
    const reordered = {
      authentication: connection.authentication,
      host: connection.host,
      environmentId: connection.environmentId,
    }
    const app = controller.create({ ...recipe, connection: reordered })
    expect((await controller.start(app.id)).status).toBe('ready')
    expect(useSshEnvironmentsStore.getState().connectionStatuses[environment.id]?.status).toBe('connected')
  })

  it('attaches and updates only the remote port, preserving its page recipe identity', async () => {
    const { controller, calls } = fixture()
    const app = controller.create({ ...recipe, launch: { mode: 'attach', port: 1420 } })
    await controller.start(app.id)
    expect(calls.at(-1)?.args).toEqual({
      request: { id: app.id, cwd: recipe.cwd, connection, mode: 'attach', port: 1420 },
    })
    for (const changes of [{ executable: 'node' }, { args: [] }, { port: null }]) {
      await expect(controller.update(app.id, changes)).rejects.toThrow('only change its remote port')
    }
    expect(calls.filter((call) => call.command === 'agent_preview_stop')).toHaveLength(0)
    await controller.update(app.id, { port: 1421 })
    expect(controller.get(app.id)).toEqual({ ...app, launch: { mode: 'attach', port: 1421 } })
    expect(calls.filter((call) => call.command === 'agent_preview_stop')).toEqual([
      { command: 'agent_preview_stop', args: { id: app.id } },
    ])
    expect(calls.at(-1)?.args).toEqual({
      request: { id: app.id, cwd: recipe.cwd, connection, mode: 'attach', port: 1421 },
    })
    expect(() =>
      controller.create({ ...recipe, connection: undefined, launch: { mode: 'attach', port: 1420 } }),
    ).toThrow('SSH environment')
  })

  it.each(['changed', 'deleted'] as const)(
    'refuses a %s connection without starting or modifying its recipe',
    async (change) => {
      const { controller, calls } = fixture()
      const app = controller.create(recipe)
      useSshEnvironmentsStore.setState({
        environments: {
          [environment.id]:
            change === 'changed'
              ? { ...environment, host: 'other' }
              : { ...environment, deletedAt: new Date().toISOString() },
        },
      })
      await expect(controller.start(app.id)).rejects.toThrow('changed or was removed')
      await expect(controller.update(app.id, { args: ['other.js'] })).rejects.toThrow('changed or was removed')
      expect(() => controller.create(recipe)).toThrow('changed or was removed')
      expect(calls).toHaveLength(0)
      expect(controller.get(app.id)).toEqual(app)
    },
  )

  it('reconciles native sessions after reload even when their page has not reopened', async () => {
    const { controller, calls } = fixture()
    const app = controller.create(recipe)
    const observed: LocalAppStatus[] = []
    controller.subscribe((value) => observed.push(value))
    useSshEnvironmentsStore.setState({ environments: {} })
    await controller.stopInvalidSshPreviews()
    await controller.stopInvalidSshPreviews()
    expect(calls).toEqual([{ command: 'agent_preview_stop', args: { id: app.id } }])
    expect(observed.at(-1)).toMatchObject({
      id: app.id,
      status: 'failed',
      url: null,
      error: expect.stringContaining('changed or was removed'),
    })
    expect(controller.get(app.id)).toEqual(app)
  })

  it('keeps recipes and retries reconciliation after a native stop failure', async () => {
    let attempts = 0
    const controller = createLocalAppController(
      async <T>() => {
        if (++attempts === 1) {
          throw new Error('IPC disconnected')
        }
        return null as T
      },
      () => true,
    )
    const app = controller.create(recipe)
    useSshEnvironmentsStore.setState({ environments: {} })
    await expect(controller.stopInvalidSshPreviews()).rejects.toThrow('IPC disconnected')
    expect(controller.get(app.id)).toEqual(app)
    await controller.stopInvalidSshPreviews()
    expect(attempts).toBe(2)
  })

  it('cancels before native admission finishes and cleans up a late start response', async () => {
    const entered = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<LocalAppStatus>()
    const cancelled = Promise.withResolvers<void>()
    const commands: string[] = []
    let running = false
    const native = async <T>(command: string): Promise<T> => {
      commands.push(command)
      if (command === 'agent_preview_start') {
        entered.resolve()
        const result = await pending.promise
        running = true
        return result as T
      }
      if (command === 'agent_preview_stop') {
        running = false
        cancelled.resolve()
      }
      return null as T
    }
    const controller = createLocalAppController(native, () => true)
    const app = controller.create(recipe)
    const started = controller.start(app.id).catch((error: unknown) => error)
    await entered.promise
    useSshEnvironmentsStore.setState({ environments: {} })
    const stopped = controller.stopInvalidSshPreviews()
    await cancelled.promise
    expect(commands).toContain('agent_preview_stop')
    pending.resolve(status(app.id, 'ready'))
    await stopped
    expect(await started).toBeInstanceOf(Error)
    expect(running).toBe(false)
    expect(commands.at(-1)).toBe('agent_preview_stop')
  })

  it('serializes profile cleanup before a restored connection can start again', async () => {
    const enteredStop = Promise.withResolvers<void>()
    const finishStop = Promise.withResolvers<void>()
    const commands: string[] = []
    const controller = createLocalAppController(
      async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
        commands.push(command)
        if (command === 'agent_preview_stop') {
          enteredStop.resolve()
          await finishStop.promise
        }
        return (command === 'agent_preview_start' ? status((args.request as { id: string }).id, 'ready') : null) as T
      },
      () => true,
    )
    const app = controller.create(recipe)
    useSshEnvironmentsStore.setState({ environments: {} })
    const stopping = controller.stopInvalidSshPreviews()
    await enteredStop.promise
    useSshEnvironmentsStore.setState({ environments: { [environment.id]: environment } })
    const started = controller.start(app.id)
    await getClock().tickAsync(0)
    expect(commands).toEqual(['agent_preview_stop'])
    finishStop.resolve()
    await stopping
    expect((await started).status).toBe('ready')
    expect(commands).toEqual(['agent_preview_stop', 'agent_preview_status', 'agent_preview_start'])
  })

  it('checks the exact connection again after native readiness before exposing the URL', async () => {
    const commands: string[] = []
    const controller = createLocalAppController(
      async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
        commands.push(command)
        if (command !== 'agent_preview_start') {
          return null as T
        }
        useSshEnvironmentsStore.setState({ environments: {} })
        return status((args.request as { id: string }).id, 'ready') as T
      },
      () => true,
    )
    const app = controller.create(recipe)
    const observed: LocalAppStatus[] = []
    controller.subscribe((value) => observed.push(value))
    await expect(controller.start(app.id)).rejects.toThrow('changed or was removed')
    expect(commands.at(-1)).toBe('agent_preview_stop')
    expect(observed.some((value) => value.status === 'ready')).toBe(false)
  })

  it('allows SSH setup beyond the local deadline but bounds startup and stops it on timeout', async () => {
    const commands: string[] = []
    let admitted = false
    const controller = createLocalAppController(
      async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
        commands.push(command)
        if (command === 'agent_preview_start') {
          admitted = true
        }
        const id = String(args.id ?? (args.request as { id: string } | undefined)?.id)
        return (command === 'agent_preview_stop' || !admitted ? null : status(id, 'starting')) as T
      },
      () => true,
    )
    const app = controller.create(recipe)
    let settled = false
    const started = controller
      .start(app.id)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true
      })
    await getClock().tickAsync(36_000)
    expect(settled).toBe(false)
    expect(commands).not.toContain('agent_preview_stop')
    await getClock().tickAsync(90_000)
    expect(await started).toEqual(expect.objectContaining({ message: 'Timed out waiting for the local app to start' }))
    expect(commands.at(-1)).toBe('agent_preview_stop')
  })
})
