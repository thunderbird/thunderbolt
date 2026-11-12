/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { Tool } from 'ai'
import type { LocalApp, LocalAppStatus } from '@shared/local-app-protocol'
import { useSshEnvironmentsStore } from '@/agent-execution/ssh-environments'
import { createLocalAppTools, type LocalAppToolController } from './local-app-tools'

const app: LocalApp = {
  id: 'app-one',
  owner: { kind: 'project', id: 'project-one' },
  title: 'Test app',
  cwd: '/workspace/project',
  launch: { executable: 'bun', args: ['run', 'dev', '--port', '{port}'] },
  createdAt: '2026-11-10T00:00:00Z',
}
const ready: LocalAppStatus = { id: app.id, status: 'ready', url: 'http://127.0.0.1:12345/', error: null, logs: '' }
const run = (entry: Tool, input: unknown) => entry.execute?.(input as never, { toolCallId: 'call-one', messages: [] })

const fixture = (record = app, connection?: LocalApp['connection']) => {
  const controller = {
    create: mock(() => record),
    get: mock(() => record),
    list: mock(() => [record]),
    start: mock(async () => ready),
    status: mock(async () => ready),
    stop: mock(async () => ({ ...ready, status: 'stopped' as const })),
    restart: mock(async () => ready),
    update: mock(async () => ready),
  } satisfies LocalAppToolController
  const open = mock(() => 'session-one')
  return {
    controller,
    open,
    tools: createLocalAppTools({ owner: app.owner, cwd: app.cwd, onOpen: open, connection }, controller),
  }
}

const connection = { environmentId: 'ssh-one', host: 'vm', authentication: 'agent' } as const

beforeEach(() =>
  useSshEnvironmentsStore.setState({
    environments: {
      [connection.environmentId]: {
        id: connection.environmentId,
        name: 'VM',
        host: connection.host,
        authentication: connection.authentication,
        cwd: app.cwd,
        deletedAt: null,
      },
    },
  }),
)
afterEach(() => useSshEnvironmentsStore.setState({ environments: {} }))

describe('local app tools', () => {
  it('creates and opens a stable page source after the server is ready', async () => {
    const { tools, controller, open } = fixture()
    const result = await run(tools.local_app, { action: 'create', title: app.title, ...app.launch })
    expect(controller.create).toHaveBeenCalledWith({
      owner: app.owner,
      cwd: app.cwd,
      title: app.title,
      launch: app.launch,
    })
    expect(open).toHaveBeenCalledWith({
      id: 'local-app:app-one',
      title: app.title,
      source: { kind: 'local-app', appId: app.id, projectId: app.owner.id },
    })
    expect(result).toMatchObject({ appId: app.id, sessionId: 'session-one', status: 'ready' })
    expect(JSON.stringify(result)).not.toContain(app.cwd)
    expect(JSON.stringify(result)).not.toContain(ready.url!)
    expect(result).not.toHaveProperty('launch')
  })

  it('refuses operations on a different project or a changed working folder', async () => {
    for (const record of [
      { ...app, owner: { kind: 'project' as const, id: 'another-project' } },
      { ...app, cwd: '/different' },
      { ...app, connection },
    ]) {
      const { tools, controller } = fixture(record)
      for (const action of ['start', 'status', 'stop', 'restart', 'update']) {
        await expect(run(tools.local_app, { action, appId: app.id })).rejects.toThrow('current environment')
      }
      expect(controller.update).not.toHaveBeenCalled()
      expect(controller.start).not.toHaveBeenCalled()
      expect(controller.status).not.toHaveBeenCalled()
      expect(await run(tools.local_app, { action: 'list' })).toEqual({ apps: [] })
    }
  })

  it('opens SSH previews through the same stable page and live session contract', async () => {
    const remote = { ...app, connection }
    const { tools, controller, open } = fixture(remote, connection)
    expect(await run(tools.local_app, { action: 'create', title: app.title, ...app.launch })).toMatchObject({
      appId: app.id,
      sessionId: 'session-one',
      page: { id: 'local-app:app-one' },
      status: 'ready',
    })
    expect(controller.create).toHaveBeenCalledWith({
      owner: app.owner,
      cwd: app.cwd,
      title: app.title,
      launch: app.launch,
      connection,
    })
    expect(open).toHaveBeenCalledTimes(1)
    const elsewhere = fixture(remote, { ...connection, host: 'another-vm' })
    await expect(run(elsewhere.tools.local_app, { action: 'restart', appId: app.id })).rejects.toThrow(
      'current environment',
    )
    expect(await run(elsewhere.tools.local_app, { action: 'list' })).toEqual({ apps: [] })
  })

  it('attaches an existing remote service without supplying a launch command', async () => {
    const remote = { ...app, connection, launch: { mode: 'attach', port: 1420 } as const }
    const { tools, controller } = fixture(remote, connection)
    const output = await run(tools.local_app, { action: 'attach', title: app.title, port: 1420 })
    expect(controller.create).toHaveBeenCalledWith({
      owner: app.owner,
      cwd: app.cwd,
      title: app.title,
      launch: { mode: 'attach', port: 1420 },
      connection,
    })
    expect(output).toMatchObject({ appId: app.id, sessionId: 'session-one', status: 'ready' })
    expect(JSON.stringify(output)).not.toContain('1420')
    expect(JSON.stringify(output)).not.toContain('environmentId')
  })

  it('does not open a page when its SSH profile changes during startup', async () => {
    const { tools, controller, open } = fixture({ ...app, connection }, connection)
    controller.start.mockImplementation(async () => {
      useSshEnvironmentsStore.setState({ environments: {} })
      return ready
    })
    await expect(run(tools.local_app, { action: 'create', title: app.title, ...app.launch })).rejects.toThrow(
      'changed or was removed',
    )
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects unsupported or ambiguous attach requests before creating a recipe', async () => {
    const local = fixture()
    await expect(run(local.tools.local_app, { action: 'attach', title: 'App', port: 1420 })).rejects.toThrow(
      'SSH environment',
    )
    expect(local.controller.create).not.toHaveBeenCalled()
    const remote = fixture({ ...app, connection }, connection)
    await expect(run(remote.tools.local_app, { action: 'attach', title: 'App' })).rejects.toThrow('remote port')
    await expect(
      run(remote.tools.local_app, { action: 'attach', title: 'App', port: 1420, executable: 'node' }),
    ).rejects.toThrow('use create')
    expect(remote.controller.create).not.toHaveBeenCalled()
  })

  it.each(['start', 'restart', 'update'] as const)(
    'returns the live session id after %s and retains the page identity',
    async (action) => {
      const { tools, controller, open } = fixture()
      const result = await run(tools.local_app, { action, appId: app.id, args: ['server.cjs'], port: null })
      expect(result).toMatchObject({
        appId: app.id,
        page: { id: 'local-app:app-one' },
        sessionId: 'session-one',
        status: 'ready',
      })
      expect(open).toHaveBeenCalledTimes(1)
      expect(controller.create).not.toHaveBeenCalled()
      if (action === 'update') {
        expect(controller.update).toHaveBeenCalledWith(
          app.id,
          { args: ['server.cjs'], executable: undefined, port: null },
          undefined,
        )
        expect(controller.start).not.toHaveBeenCalled()
        expect(result).toHaveProperty('updated', true)
      }
    },
  )

  it('does not reopen a failed or cancelled update', async () => {
    const { tools, controller, open } = fixture()
    controller.update.mockRejectedValue(new Error('Invalid entrypoint'))
    await expect(run(tools.local_app, { action: 'update', appId: app.id, args: ['missing.cjs'] })).rejects.toThrow(
      'Invalid entrypoint',
    )
    expect(open).not.toHaveBeenCalled()
    expect(controller.create).not.toHaveBeenCalled()
    await expect(
      tools.local_app.execute!(
        { action: 'update', appId: app.id, args: ['server.cjs'] },
        { toolCallId: 'aborted', messages: [], abortSignal: AbortSignal.abort() },
      ),
    ).rejects.toThrow()
    expect(controller.update).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed creation before persisting or launching anything', async () => {
    const { tools, controller } = fixture()
    await expect(run(tools.local_app, { action: 'create', title: 'Incomplete' })).rejects.toThrow('executable')
    expect(controller.create).not.toHaveBeenCalled()
    await expect(run(tools.local_app, { action: 'start' })).rejects.toThrow('Provide appId')
  })

  it('does not reopen pages just to inspect or stop their process', async () => {
    const { tools, controller, open } = fixture()
    await run(tools.local_app, { action: 'status', appId: app.id })
    await run(tools.local_app, { action: 'stop', appId: app.id })
    expect(controller.status).toHaveBeenCalledTimes(1)
    expect(controller.stop).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })
})
