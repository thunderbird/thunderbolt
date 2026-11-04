/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { startCloudAgentLifecycle } from './lifecycle'

const fixture = () => {
  const calls: string[] = []
  const state = { fatal: (_error: Error) => {}, failTick: false, failRuntime: false, failOpen: false }
  const options: Parameters<typeof startCloudAgentLifecycle>[0] = {
    openStore: async (fatal) => {
      state.fatal = fatal
      if (state.failOpen) {
        fatal(new Error('Owner lost during initialization'))
      }
      return {
        openNamespace: async () => {
          throw new Error('Unused')
        },
        close: async () => {
          calls.push('store.close')
        },
      }
    },
    createRuntime: () => {
      calls.push('runtime.create')
      if (state.failRuntime) {
        throw new Error('Runtime setup failed')
      }
      return {
        run: async () => {},
        stop: async () => {},
        close: async () => {
          calls.push('runtime.close')
        },
      }
    },
    createScheduler: () => ({
      tick: async () => {
        calls.push('scheduler.tick')
        if (state.failTick) {
          throw new Error('Initial scan failed')
        }
      },
      stop: () => {
        calls.push('scheduler.stop')
      },
      drain: async () => {
        calls.push('scheduler.drain')
      },
    }),
    collectGarbage: async () => {
      calls.push('garbage')
    },
    onFatal: () => {
      calls.push('fatal')
    },
    reportError: (code) => {
      calls.push(code)
    },
  }
  return { calls, state, options }
}

describe('cloud runtime process lifecycle', () => {
  it('cleans up an owner failure before the runtime has been assigned', async () => {
    const f = fixture()
    f.state.failOpen = true
    await expect(startCloudAgentLifecycle(f.options)).rejects.toThrow('Owner lost during initialization')
    expect(f.calls).toEqual(['fatal', 'store.close'])
  })

  it('releases the store when runtime construction fails', async () => {
    const f = fixture()
    f.state.failRuntime = true
    await expect(startCloudAgentLifecycle(f.options)).rejects.toThrow('Runtime setup failed')
    expect(f.calls).toEqual(['runtime.create', 'store.close'])
  })

  it('stops all timers and drains when the first scheduler scan fails', async () => {
    const f = fixture()
    f.state.failTick = true
    await expect(startCloudAgentLifecycle(f.options)).rejects.toThrow('Initial scan failed')
    expect(f.calls).toEqual([
      'runtime.create',
      'scheduler.tick',
      'scheduler.stop',
      'runtime.close',
      'store.close',
      'scheduler.drain',
    ])
  })

  it('stops admissions on ownership loss and makes subsequent shutdown idempotent', async () => {
    const f = fixture()
    const lifecycle = await startCloudAgentLifecycle(f.options)
    f.state.fatal(new Error('Connection lost'))
    f.state.fatal(new Error('Duplicate socket notification'))
    await lifecycle.close()
    await lifecycle.close()
    expect(f.calls.filter((call) => call === 'fatal')).toHaveLength(1)
    expect(f.calls.filter((call) => call === 'runtime.close')).toHaveLength(1)
    expect(f.calls.filter((call) => call === 'store.close')).toHaveLength(1)
    expect(f.calls.indexOf('scheduler.stop')).toBeLessThan(f.calls.indexOf('runtime.close'))
    expect(f.calls.at(-1)).toBe('scheduler.drain')
  })
})
