/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { runInSandboxWorker, type SandboxWorker } from './run-in-worker'

const createFakeWorker = () => {
  const worker: SandboxWorker & { scripts: string[]; terminated: boolean } = {
    onmessage: null,
    onerror: null,
    scripts: [],
    terminated: false,
    postMessage: (script) => worker.scripts.push(script),
    terminate: () => {
      worker.terminated = true
    },
  }
  return worker
}

describe('runInSandboxWorker', () => {
  it('returns what the Worker answers and terminates it', async () => {
    const worker = createFakeWorker()
    const run = runInSandboxWorker('saveFile()', undefined, () => worker)
    worker.onmessage?.(new MessageEvent('message', { data: { ok: true, files: [], logs: '' } }))

    expect(await run).toEqual({ ok: true, files: [], logs: '' })
    expect(worker.scripts).toEqual(['saveFile()'])
    expect(worker.terminated).toBe(true)
  })

  it('shuts down a Worker that stops answering', async () => {
    const worker = createFakeWorker()
    const run = runInSandboxWorker('while (true) {}', undefined, () => worker)
    await getClock().tickAsync(35_000)

    expect(await run).toMatchObject({ ok: false, error: expect.stringContaining('did not answer within 35 seconds') })
    expect(worker.terminated).toBe(true)
  })

  it('reports a Worker that fails to start', async () => {
    const worker = createFakeWorker()
    const run = runInSandboxWorker('', undefined, () => worker)
    worker.onerror?.(new ErrorEvent('error', { message: 'Failed to fetch' }))

    expect(await run).toMatchObject({ ok: false, error: 'The sandbox failed to start: Failed to fetch' })
  })

  it('stops the Worker when the turn is stopped', async () => {
    const worker = createFakeWorker()
    const controller = new AbortController()
    const run = runInSandboxWorker('', controller.signal, () => worker)
    controller.abort(new Error('stopped'))

    await expect(run).rejects.toThrow('stopped')
    expect(worker.terminated).toBe(true)
  })

  it('starts no Worker when the turn was already stopped', () => {
    let created = false
    expect(() =>
      runInSandboxWorker('', AbortSignal.abort(new Error('stopped')), () => {
        created = true
        return createFakeWorker()
      }),
    ).toThrow('stopped')
    expect(created).toBe(false)
  })
})
