/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { describe, expect, it, mock } from 'bun:test'
import {
  createPreviewClient,
  type PreviewClient,
  PreviewLoadError,
  previewTimeouts,
  type PreviewWorker,
  type PreviewWorkerMessage,
  WorkbookTooLargeError,
} from './xlsx-preview-client'
import type { PreviewRequest } from './xlsx-preview-reader'

/** A Worker stand-in that keeps the requests, so a test answers them in any order. */
const fakeWorker = () => {
  const requests: PreviewRequest[] = []
  const worker: PreviewWorker = {
    onmessage: null,
    onerror: null,
    postMessage: (request) => requests.push(request),
    terminate: mock(),
  }
  const post = (data: PreviewWorkerMessage) => worker.onmessage?.(new MessageEvent('message', { data }))
  return { worker, requests, post }
}

/** A client over a fake Worker that has loaded Excelize. */
const readyClient = () => {
  const fake = fakeWorker()
  const client = createPreviewClient(() => fake.worker)
  fake.post('ready')
  return { ...fake, client }
}

const layout = {
  rows: [],
  cols: [],
  rowHeights: [],
  colWidths: [],
  frozenRows: 0,
  frozenCols: 0,
  merges: [],
  overlays: [],
  leftOutObjects: 0,
  rtl: false,
}

describe('the preview client', () => {
  it('matches each answer to its call, whatever order they come back in', async () => {
    const { client, requests, post } = readyClient()

    const sheet = client.sheet(0)
    const rows = client.rows(0, 0, 50)
    const [sheetRequest, rowsRequest] = requests
    post({ id: rowsRequest.id, call: 'rows', result: { rows: [], styles: [] } })
    post({ id: sheetRequest.id, call: 'sheet', result: layout })

    expect(await rows).toEqual({ rows: [], styles: [] })
    expect(await sheet).toEqual(layout)
    expect(rowsRequest).toEqual({ id: rowsRequest.id, call: 'rows', args: [0, 0, 50] })
  })

  it('rejects a call the reader failed, with its message', async () => {
    const { client, requests, post } = readyClient()

    const open = client.open(new Uint8Array([1]))
    post({ id: requests[0].id, error: 'Error: zip: not a valid zip file' })

    await expect(open).rejects.toThrow('zip: not a valid zip file')
  })

  it('rejects a call the reader found too large with the error that says so', async () => {
    const { client, requests, post } = readyClient()

    const open = client.open(new Uint8Array([1])).catch((error) => error)
    post({ id: requests[0].id, error: 'Error: Excelize used more than 1 bytes of memory.', tooLarge: true })

    expect(await open).toBeInstanceOf(WorkbookTooLargeError)
  })

  it('rejects every waiting call when the Worker fails', async () => {
    const { client, worker } = readyClient()

    const sheet = client.sheet(0).catch(String)
    const rows = client.rows(0, 0, 50).catch(String)
    worker.onerror?.(new ErrorEvent('error', { message: 'out of memory' }))

    expect(await sheet).toBe('Error: The preview Worker failed: out of memory')
    expect(await rows).toBe('Error: The preview Worker failed: out of memory')
  })

  it('stops a Worker that gives no answer in time, and fails every waiting call as too large', async () => {
    const { client, worker } = readyClient()

    const open = client.open(new Uint8Array([1])).catch((error) => error)
    const rows = client.rows(0, 0, 50).catch(String)
    getClock().tick(previewTimeouts.callMs)

    expect(await rows).toBe('Error: The preview Worker gave no answer within 60 seconds and was stopped.')
    expect(await open).toBeInstanceOf(WorkbookTooLargeError)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('times a call only once the Worker has loaded Excelize, however long the download takes', async () => {
    const { worker, post } = fakeWorker()
    const client = createPreviewClient(() => worker)
    const open = client.open(new Uint8Array([1])).catch((error) => error)

    // A slow download: the call waits, untimed, until Excelize has loaded.
    getClock().tick(previewTimeouts.callMs + 1)
    expect(worker.terminate).not.toHaveBeenCalled()
    post('ready')
    getClock().tick(previewTimeouts.callMs)

    expect(await open).toBeInstanceOf(WorkbookTooLargeError)
  })

  it('says the preview could not load when Excelize does not load in time, fails to load, or the Worker fails first', async () => {
    const stoppedBy = [
      () => getClock().tick(previewTimeouts.loadMs),
      (fake: ReturnType<typeof fakeWorker>) => fake.post('loadFailed'),
      (fake: ReturnType<typeof fakeWorker>) =>
        fake.worker.onerror?.(new ErrorEvent('error', { message: 'Failed to fetch excelize.wasm.gz' })),
    ]
    for (const stop of stoppedBy) {
      const fake = fakeWorker()
      const client = createPreviewClient(() => fake.worker)
      const open = client.open(new Uint8Array([1])).catch((error) => error)
      stop(fake)

      expect(await open).toBeInstanceOf(PreviewLoadError)
      expect(fake.worker.terminate).toHaveBeenCalledTimes(1)
    }
  })

  it('terminates the Worker on close', () => {
    const { client, worker } = readyClient()

    client.close()

    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('once the Worker has stopped, fails every new call at once without posting it', async () => {
    const stoppedBy = {
      timeout: (client: PreviewClient) => {
        void client.rows(0, 0, 50).catch(String)
        getClock().tick(previewTimeouts.callMs)
      },
      failure: (_: PreviewClient, worker: PreviewWorker) =>
        worker.onerror?.(new ErrorEvent('error', { message: 'out of memory' })),
      close: (client: PreviewClient) => client.close(),
    }
    for (const stop of Object.values(stoppedBy)) {
      const { client, worker, requests } = readyClient()
      stop(client, worker)
      const posted = requests.length

      await expect(client.sheet(0)).rejects.toThrow()
      expect(requests).toHaveLength(posted)
    }
  })
})
