/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import type { Browser, Page, Request } from 'playwright'
import { collectScenario } from './collect'
import { READ_SNAPSHOT, RESET_RENDERS } from './inject'

/** Simulate browser boundaries while keeping the production axe and collector logic. */
const fixture = (failure?: string) => {
  const events: string[] = []
  const handlers = new Map<string, (request: Request) => void>()
  const step = async (name: string) => {
    events.push(name)
    if (failure === name) throw new Error(`Failed ${name}`)
  }
  const snapshot = { vitals: [], loaf: [], longTasks: [], renders: [], commits: 0 }
  const close = mock(async () => {})
  const page = {
    addInitScript: async () => step('instrumentation'),
    close: async () => step('warmup-close'),
    on: (event: string, handler: (request: Request) => void) => handlers.set(event, handler),
    off: (event: string) => handlers.delete(event),
    goto: async () => step('navigation'),
    locator: () => ({ first: () => ({ waitFor: async () => step('readiness') }) }),
    waitForTimeout: async () => {},
    waitForFunction: async () => {},
    keyboard: { press: async () => step('escape') },
    mouse: { move: async () => {}, wheel: async () => {} },
    addScriptTag: async () => step('axe-injection'),
    evaluate: async (script: string) => {
      if (script === READ_SNAPSHOT) {
        await step('snapshot')
        return snapshot
      }
      if (script === RESET_RENDERS) {
        await step('noise-reset')
        return
      }
      if (script.includes('axe.run')) {
        await step('a11y')
        return {
          violations: [
            { id: 'dialog-name', impact: 'serious', help: 'Name the dialog', nodes: [{ target: ['#open-dialog'] }] },
          ],
        }
      }
      return []
    },
    screenshot: async () => step('screenshot'),
  } as unknown as Page
  const newPage = mock(async () => page)
  const context = { newPage, close }
  const browser = { newContext: async () => context } as unknown as Browser
  const scenario = {
    name: 'dialog',
    path: '/chats/new',
    description: '',
    tags: [],
    interact: async () => step('interaction'),
  }
  return { browser, scenario, events, close, newPage, handlers }
}

describe('scenario probe integrity', () => {
  it.each(['navigation', 'readiness', 'interaction', 'snapshot', 'axe-injection', 'a11y', 'noise-reset', 'screenshot'])(
    'rejects a failed %s check and closes its context instead of returning healthy empty metrics',
    async (failure) => {
      const f = fixture(failure)
      await expect(collectScenario(f.browser, 'firefox', 'http://fixture.test', f.scenario, '/output')).rejects.toThrow(
        `Failed ${failure}`,
      )
      expect(f.close).toHaveBeenCalledTimes(1)
    },
  )

  it('warms route chunks in a separate document before installing measurement probes', async () => {
    const f = fixture()
    await collectScenario(f.browser, 'firefox', 'http://fixture.test', f.scenario, '/output')
    expect(f.newPage).toHaveBeenCalledTimes(2)
    expect(f.events.indexOf('navigation')).toBeLessThan(f.events.indexOf('instrumentation'))
    expect(f.events.indexOf('instrumentation')).toBeLessThan(f.events.lastIndexOf('navigation'))
    expect(f.events.indexOf('warmup-close')).toBeLessThan(f.events.indexOf('instrumentation'))
  })

  it('checks accessibility on the open overlay before dismissing it for idle render measurements', async () => {
    const f = fixture()
    const report = await collectScenario(f.browser, 'firefox', 'http://fixture.test', f.scenario, '/output')
    expect(report.a11y).toEqual([
      { ruleId: 'dialog-name', impact: 'serious', help: 'Name the dialog', selectors: ['#open-dialog'] },
    ])
    expect(f.events.indexOf('a11y')).toBeLessThan(f.events.indexOf('escape'))
    expect(f.close).toHaveBeenCalledTimes(1)
  })
})

it('retains failed requests despite a successful retry and the report size cap', async () => {
  const f = fixture()
  const request = {
    url: () => 'http://fixture.test/retry',
    method: () => 'GET',
    resourceType: () => 'fetch',
    response: async () => ({ status: () => 200 }),
    sizes: async () => ({ responseBodySize: 10, responseHeadersSize: 20 }),
    timing: () => ({ startTime: Date.now(), responseEnd: 50 }),
  } as unknown as Request
  f.scenario.interact = async () => {
    for (const index of Array.from({ length: 65 }, (_, index) => index)) {
      f.handlers.get('requestfinished')?.({
        ...request,
        url: () => (index === 0 ? request.url() : `${request.url()}?i=${index}`),
      } as Request)
    }
    f.handlers.get('requestfailed')?.(request)
  }
  const report = await collectScenario(f.browser, 'firefox', 'http://fixture.test', f.scenario, '/output')
  expect(report.network.length).toBe(60)
  expect(report.network[0].status).toBe(0)
  expect(
    report.network
      .filter(({ url }) => url === request.url())
      .map(({ status }) => status)
      .sort(),
  ).toEqual([0, 200])
  expect(f.handlers.has('requestfailed')).toBe(false)
})
