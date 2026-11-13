/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { sandboxLimits } from './constants'
import type { SandboxJob, SandboxResult } from './sandbox'

/** What the Worker posts: `'ready'` once the sandbox is loaded and the script starts, then the result. */
export type SandboxMessage = 'ready' | SandboxResult

/** The part of a Worker the host uses, so a test can drive a fake one. */
export type SandboxWorker = {
  onmessage: ((event: MessageEvent<SandboxMessage>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage: (job: SandboxJob, transfer: Transferable[]) => void
  terminate: () => void
}

/** A module Worker built from its own file, loaded the first time a script runs. */
const createOfficeWorker = (): SandboxWorker =>
  new Worker(new URL('./office-script.worker.ts', import.meta.url), { type: 'module' })

/** How long past the VM's own limit the host waits before it gives up on the Worker. */
const watchdogGraceMs = 5_000

/** How long the Worker may take to download and load the sandbox, before the script's own time starts. */
const loadTimeoutMs = 120_000

/**
 * Run a job in a fresh sandbox Worker and terminate the Worker afterwards. The inputs' buffers move to the
 * Worker, so the caller must not read them again. The VM interrupt enforces the time limit; this watchdog
 * only fires when the Worker stops answering (for example inside a long WASM call).
 * Loading the sandbox has its own, longer limit, and the script's watchdog starts only when the Worker says
 * it is ready: in WebKit a Worker's fetches go through the page's main thread, so a busy page holds up the
 * load without the script having run. Rejects with the signal's reason on Stop.
 */
export const runInSandboxWorker = (
  job: SandboxJob,
  signal?: AbortSignal,
  createWorker: () => SandboxWorker = createOfficeWorker,
): Promise<SandboxResult> => {
  signal?.throwIfAborted()
  const worker = createWorker()
  const { promise, resolve, reject } = Promise.withResolvers<SandboxResult>()
  const giveUp = (error: string) => () => resolve({ ok: false, error, logs: '' })
  const timeoutMs = sandboxLimits.timeoutMs + watchdogGraceMs
  let watchdog = setTimeout(
    giveUp(
      `The sandbox did not finish loading within ${loadTimeoutMs / 1000} seconds and was shut down before the script ran. Call the tool again.`,
    ),
    loadTimeoutMs,
  )
  const onAbort = () => reject(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  worker.onmessage = ({ data }) => {
    if (data !== 'ready') {
      resolve(data)
      return
    }
    clearTimeout(watchdog)
    watchdog = setTimeout(
      giveUp(
        `The sandbox stopped answering ${timeoutMs / 1000} seconds after the script started and was shut down. If the script does heavy work, make it do less; otherwise call the tool again.`,
      ),
      timeoutMs,
    )
  }
  worker.onerror = (event) => {
    event.preventDefault()
    resolve({ ok: false, error: `The sandbox failed to start: ${event.message}`, logs: '' })
  }
  worker.postMessage(
    job,
    job.inputs.map(({ bytes }) => bytes.buffer),
  )
  return promise.finally(() => {
    clearTimeout(watchdog)
    signal?.removeEventListener('abort', onAbort)
    worker.terminate()
  })
}
