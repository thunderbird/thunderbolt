/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PreviewAnswer, PreviewCalls, PreviewRequest } from './xlsx-preview-reader'

/** The preview reader's calls, answered asynchronously, and `close`, which ends the Worker and frees its memory. */
export type PreviewClient = {
  [K in keyof PreviewCalls]: (...args: Parameters<PreviewCalls[K]>) => Promise<ReturnType<PreviewCalls[K]>>
} & { close: () => void }

/** What the Worker posts: `'ready'` once Excelize has loaded (`'loadFailed'` if it could not), then each answer. */
export type PreviewWorkerMessage = 'ready' | 'loadFailed' | PreviewAnswer

/** The part of a Worker the client uses, so a test can drive a fake one. */
export type PreviewWorker = {
  onmessage: ((event: MessageEvent<PreviewWorkerMessage>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage: (request: PreviewRequest) => void
  terminate: () => void
}

/** A module Worker built from its own file: the app CSP and the Tauri webviews block `blob:` and `data:` Workers. */
const createPreviewWorker = (): PreviewWorker =>
  new Worker(new URL('./xlsx-preview.worker.ts', import.meta.url), { type: 'module' })

/**
 * A workbook, or a sheet of it, too large for the preview to read: it ran past a size bound, Excelize's memory
 * ceiling or the time a call may take. The preview says the file is too large and offers Download, so a large file
 * is never called damaged.
 */
export class WorkbookTooLargeError extends Error {}

/** The Worker could not load Excelize, for example on a slow or offline network. The file may be fine. */
export class PreviewLoadError extends Error {}

const unexpected = (answer: PreviewAnswer) => {
  if (!('error' in answer)) {
    return new Error(`The preview Worker answered ${answer.call} to another call.`)
  }
  return answer.tooLarge ? new WorkbookTooLargeError(answer.error) : new Error(answer.error)
}

/**
 * How long the Worker may take to download and load Excelize, and then each call, before it counts as stuck. A
 * call's time starts only once Excelize has loaded.
 */
export const previewTimeouts = { loadMs: 120_000, callMs: 60_000 }

type Pending = {
  settle: (answer: PreviewAnswer) => void
  fail: (error: Error) => void
  watchdog?: ReturnType<typeof setTimeout>
}

/** The next request id, whether Excelize has loaded, and why the Worker was stopped, once it is. */
type ClientState = { nextId: number; loaded: boolean; stopped?: Error }

/**
 * Start a preview Worker and talk to it. The Worker loads Excelize when it starts and keeps the workbook open, so
 * sheet switches and scrolling read from it. `close` terminates it, which frees Excelize's memory. A call that gets
 * no answer in time terminates the Worker and fails every call still waiting: a workbook can keep Excelize busy for
 * minutes, and only terminating the Worker stops it. Loading Excelize has its own, longer limit. Once the Worker is
 * stopped, any later call fails at once.
 */
export const createPreviewClient = (createWorker: () => PreviewWorker = createPreviewWorker): PreviewClient => {
  const worker = createWorker()
  const pending = new Map<number, Pending>()
  const state: ClientState = { nextId: 0, loaded: false }

  const stop = (error: Error) => {
    state.stopped = error
    clearTimeout(loadWatchdog)
    worker.terminate()
    for (const { fail, watchdog } of pending.values()) {
      clearTimeout(watchdog)
      fail(error)
    }
    pending.clear()
  }

  const loadWatchdog = setTimeout(() => {
    stop(
      new PreviewLoadError(`The preview Worker did not load Excelize within ${previewTimeouts.loadMs / 1000} seconds.`),
    )
  }, previewTimeouts.loadMs)

  const watch = (waiting: Pending) => {
    waiting.watchdog = setTimeout(() => {
      const seconds = previewTimeouts.callMs / 1000
      stop(new WorkbookTooLargeError(`The preview Worker gave no answer within ${seconds} seconds and was stopped.`))
    }, previewTimeouts.callMs)
  }

  worker.onmessage = ({ data }) => {
    if (data === 'ready') {
      state.loaded = true
      clearTimeout(loadWatchdog)
      pending.forEach(watch)
      return
    }
    if (data === 'loadFailed') {
      stop(new PreviewLoadError('The preview Worker could not load Excelize.'))
      return
    }
    const waiting = pending.get(data.id)
    clearTimeout(waiting?.watchdog)
    pending.delete(data.id)
    waiting?.settle(data)
  }
  worker.onerror = (event) => {
    event.preventDefault()
    const message = `The preview Worker failed: ${event.message}`
    stop(state.loaded ? new Error(message) : new PreviewLoadError(message))
  }

  const send = (request: PreviewRequest) => {
    if (state.stopped) {
      return Promise.reject(state.stopped)
    }
    return new Promise<PreviewAnswer>((resolve, reject) => {
      const waiting: Pending = { settle: resolve, fail: reject }
      pending.set(request.id, waiting)
      if (state.loaded) {
        watch(waiting)
      }
      worker.postMessage(request)
    })
  }

  return {
    open: async (...args) => {
      const answer = await send({ id: state.nextId++, call: 'open', args })
      if ('error' in answer || answer.call !== 'open') {
        throw unexpected(answer)
      }
      return answer.result
    },
    sheet: async (...args) => {
      const answer = await send({ id: state.nextId++, call: 'sheet', args })
      if ('error' in answer || answer.call !== 'sheet') {
        throw unexpected(answer)
      }
      return answer.result
    },
    rows: async (...args) => {
      const answer = await send({ id: state.nextId++, call: 'rows', args })
      if ('error' in answer || answer.call !== 'rows') {
        throw unexpected(answer)
      }
      return answer.result
    },
    // Calls still waiting never settle: nothing wants their answers once the preview has closed.
    close: () => {
      state.stopped = new Error('The preview Worker was closed.')
      clearTimeout(loadWatchdog)
      worker.terminate()
      for (const { watchdog } of pending.values()) {
        clearTimeout(watchdog)
      }
      pending.clear()
    },
  }
}
