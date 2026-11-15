/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { runInSandboxWorker, type SandboxWorker } from './run-in-worker'
import type { SandboxJob } from './sandbox'

const createFakeWorker = () => {
  const worker: SandboxWorker & { jobs: SandboxJob[]; transfers: Transferable[][]; terminated: boolean } = {
    onmessage: null,
    onerror: null,
    jobs: [],
    transfers: [],
    terminated: false,
    postMessage: (job, transfer) => {
      worker.jobs.push(job)
      worker.transfers.push(transfer)
    },
    terminate: () => {
      worker.terminated = true
    },
  }
  return worker
}

const job = (script: string): SandboxJob => ({ script, inputs: [] })

describe('runInSandboxWorker', () => {
  it('returns what the Worker answers and terminates it', async () => {
    const worker = createFakeWorker()
    const run = runInSandboxWorker(job('saveFile()'), undefined, () => worker)
    worker.onmessage?.(new MessageEvent('message', { data: { ok: true, files: [], logs: '' } }))

    expect(await run).toEqual({ ok: true, files: [], logs: '' })
    expect(worker.jobs).toEqual([job('saveFile()')])
    expect(worker.terminated).toBe(true)
  })

  it('moves the inputs to the Worker instead of copying them', async () => {
    const worker = createFakeWorker()
    const inputs = [
      { name: 'a.docx', bytes: new Uint8Array([1]) },
      { name: 'b.pptx', bytes: new Uint8Array([2]) },
    ]
    const run = runInSandboxWorker({ script: '', inputs }, undefined, () => worker)
    worker.onmessage?.(new MessageEvent('message', { data: { ok: true, files: [], logs: '' } }))
    await run

    expect(worker.jobs[0].inputs).toBe(inputs)
    expect(worker.transfers).toEqual([inputs.map(({ bytes }) => bytes.buffer)])
  })

  it('shuts down a Worker that stops answering once the script started', async () => {
    const worker = createFakeWorker()
    const run = runInSandboxWorker(job('while (true) {}'), undefined, () => worker)
    worker.onmessage?.(new MessageEvent('message', { data: 'ready' }))
    await getClock().tickAsync(35_000)

    expect(await run).toMatchObject({
      ok: false,
      error: expect.stringContaining('stopped answering 35 seconds after the script started'),
    })
    expect(worker.terminated).toBe(true)
  })

  it('starts the script time only when the sandbox has loaded', async () => {
    const worker = createFakeWorker()
    const run = runInSandboxWorker(job('saveFile()'), undefined, () => worker)
    await getClock().tickAsync(100_000)
    worker.onmessage?.(new MessageEvent('message', { data: 'ready' }))
    await getClock().tickAsync(34_000)
    worker.onmessage?.(new MessageEvent('message', { data: { ok: true, files: [], logs: '' } }))

    expect(await run).toEqual({ ok: true, files: [], logs: '' })
  })

  it('gives up on a sandbox that never finishes loading', async () => {
    const worker = createFakeWorker()
    const run = runInSandboxWorker(job('saveFile()'), undefined, () => worker)
    await getClock().tickAsync(120_000)

    expect(await run).toMatchObject({
      ok: false,
      error: expect.stringContaining('did not finish loading within 120 seconds'),
    })
    expect(worker.terminated).toBe(true)
  })

  it('reports a Worker that fails to start', async () => {
    const worker = createFakeWorker()
    const run = runInSandboxWorker(job(''), undefined, () => worker)
    worker.onerror?.(new ErrorEvent('error', { message: 'Failed to fetch' }))

    expect(await run).toMatchObject({ ok: false, error: 'The sandbox failed to start: Failed to fetch' })
  })

  it('stops the Worker when the turn is stopped', async () => {
    const worker = createFakeWorker()
    const controller = new AbortController()
    const run = runInSandboxWorker(job(''), controller.signal, () => worker)
    controller.abort(new Error('stopped'))

    await expect(run).rejects.toThrow('stopped')
    expect(worker.terminated).toBe(true)
  })

  it('starts no Worker when the turn was already stopped', () => {
    let created = false
    expect(() =>
      runInSandboxWorker(job(''), AbortSignal.abort(new Error('stopped')), () => {
        created = true
        return createFakeWorker()
      }),
    ).toThrow('stopped')
    expect(created).toBe(false)
  })
})
