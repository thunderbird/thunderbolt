/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as core from '@tauri-apps/api/core'
import * as platform from '@/lib/platform'
import { browserController } from '@/browser/browser-controller'
import { useAgentExecutionStore } from '@/agent-execution/store'
import { useLocalAppStore } from '@/local-apps/local-app-store'
import { localAppController } from '@/local-apps/local-app-controller'
import type { LocalApp } from '@shared/local-app-protocol'
import { usePageStore } from './page-store'
import { clearPageIdentity } from './identity-lifecycle'

/** Store real launch recipes while tests replace only native process stopping. */
const saveApp = (id: string): LocalApp => {
  const app: LocalApp = {
    id,
    title: id,
    cwd: '/tmp/project',
    owner: { kind: 'project', id: 'project' },
    launch: { executable: 'bun', args: ['run', 'dev'] },
    createdAt: '2026-11-11T00:00:00Z',
  }
  useLocalAppStore.getState().save(app)
  return app
}

describe('page identity cleanup', () => {
  beforeEach(() => {
    // Other suites replace this module with a shared mock; isolate this action's call history.
    spyOn(core, 'invoke').mockClear()
    usePageStore.setState({ sessions: [], activeId: null })
    useLocalAppStore.setState({ apps: {} })
    useAgentExecutionStore.setState({ byThread: {}, byProject: {} })
    browserController.resume()
  })
  afterEach(() => {
    mock.restore()
    browserController.resume()
    usePageStore.setState({ sessions: [], activeId: null })
    useLocalAppStore.setState({ apps: {} })
    useAgentExecutionStore.setState({ byThread: {}, byProject: {} })
  })

  it('awaits native website data removal even when no browser tab is open', async () => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
    const pending = Promise.withResolvers<void>()
    const invoke = spyOn(core, 'invoke').mockReturnValue(pending.promise)
    const clearing = clearPageIdentity(true)
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledWith('browser_clear_profile')
    expect(browserController.getState().paused).toBe(true)
    pending.resolve()
    await clearing
    expect(browserController.getState().paused).toBe(false)
  })

  it('closes page sessions and leaves control paused when native cleanup fails', async () => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
    const failure = new Error('Profile cleanup failed')
    spyOn(core, 'invoke').mockRejectedValue(failure)
    usePageStore
      .getState()
      .ensure({ id: 'site', title: 'Website', source: { kind: 'url', url: 'https://example.com' } })
    await expect(clearPageIdentity(true)).rejects.toMatchObject({ errors: [failure] })
    expect(usePageStore.getState().sessions).toEqual([])
    expect(browserController.getState().paused).toBe(true)
  })

  it('clears the browser after a preview stop fails and retains recipes until a successful retry', async () => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
    const invoke = spyOn(core, 'invoke').mockResolvedValue(undefined)
    const failedApp = saveApp('failed-preview')
    const stoppedApp = saveApp('stopped-preview')
    const execution = { location: 'computer', cwd: '/tmp/project', access: 'full' } as const
    useAgentExecutionStore.getState().setProjectExecution('project', execution)
    const failure = new Error('Could not stop preview')
    const stop = spyOn(localAppController, 'stop').mockImplementation(async (id) => {
      if (id === failedApp.id) {
        throw failure
      }
      return { id, status: 'stopped', url: null, error: null, logs: '' }
    })

    await expect(clearPageIdentity(true)).rejects.toMatchObject({ errors: [failure] })
    expect(stop.mock.calls.map(([id]) => id)).toEqual([failedApp.id, stoppedApp.id])
    expect(invoke).toHaveBeenCalledWith('browser_clear_profile')
    expect(useLocalAppStore.getState().apps).toEqual({ [failedApp.id]: failedApp, [stoppedApp.id]: stoppedApp })
    expect(useAgentExecutionStore.getState().byProject).toEqual({ project: execution })
    expect(browserController.getState().paused).toBe(true)

    stop.mockImplementation(async (id) => ({ id, status: 'stopped', url: null, error: null, logs: '' }))
    await clearPageIdentity(true)
    expect(stop).toHaveBeenCalledTimes(4)
    expect(useLocalAppStore.getState().apps).toEqual({})
    expect(useAgentExecutionStore.getState().byProject).toEqual({})
    expect(browserController.getState().paused).toBe(false)
  })

  it('reports process and browser cleanup failures together without discarding the launch recipe', async () => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
    const app = saveApp('preview')
    const processFailure = new Error('Could not stop preview')
    const profileFailure = new Error('Could not clear browser')
    spyOn(localAppController, 'stop').mockRejectedValue(processFailure)
    spyOn(core, 'invoke').mockRejectedValue(profileFailure)
    await expect(clearPageIdentity(true)).rejects.toMatchObject({ errors: [processFailure, profileFailure] })
    expect(useLocalAppStore.getState().apps).toEqual({ [app.id]: app })
    expect(browserController.getState().paused).toBe(true)
  })

  it('does not clear website credentials when retaining the identity', async () => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
    const invoke = spyOn(core, 'invoke')
    await clearPageIdentity(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not invoke desktop profile commands on web or mobile', async () => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(false)
    const invoke = spyOn(core, 'invoke')
    await clearPageIdentity(true)
    expect(invoke).not.toHaveBeenCalled()
  })
})
