/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import type { Tool } from 'ai'
import type { LocalApp, LocalAppStatus } from '@shared/local-app-protocol'
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

const fixture = (record = app) => {
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
  return { controller, open, tools: createLocalAppTools({ owner: app.owner, cwd: app.cwd, onOpen: open }, controller) }
}

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
