/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { sandboxLimits } from './constants'
import type { SandboxResult } from './sandbox'

/** The part of a Worker the host uses, so a test can drive a fake one. */
export type SandboxWorker = {
  onmessage: ((event: MessageEvent<SandboxResult>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage: (script: string) => void
  terminate: () => void
}

/** A module Worker built from its own file, loaded the first time a script runs. */
const createOfficeWorker = (): SandboxWorker =>
  new Worker(new URL('./office-script.worker.ts', import.meta.url), { type: 'module' })

/** How long past the VM's own limit the host waits before it gives up on the Worker. */
const watchdogGraceMs = 5_000

/**
 * Run a script in a fresh sandbox Worker and terminate the Worker afterwards. The VM interrupt enforces the
 * time limit; this watchdog only fires when the Worker stops answering (for example inside a long WASM call),
 * and it also covers the first download of the sandbox files. Rejects with the signal's reason on Stop.
 */
export const runInSandboxWorker = (
  script: string,
  signal?: AbortSignal,
  createWorker: () => SandboxWorker = createOfficeWorker,
): Promise<SandboxResult> => {
  signal?.throwIfAborted()
  const worker = createWorker()
  const { promise, resolve, reject } = Promise.withResolvers<SandboxResult>()
  const timeoutMs = sandboxLimits.timeoutMs + watchdogGraceMs
  const watchdog = setTimeout(
    () =>
      resolve({
        ok: false,
        error: `The sandbox did not answer within ${timeoutMs / 1000} seconds and was shut down. Make the script do less work and try again.`,
        logs: '',
      }),
    timeoutMs,
  )
  const onAbort = () => reject(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  worker.onmessage = ({ data }) => resolve(data)
  worker.onerror = (event) => {
    event.preventDefault()
    resolve({ ok: false, error: `The sandbox failed to start: ${event.message}`, logs: '' })
  }
  worker.postMessage(script)
  return promise.finally(() => {
    clearTimeout(watchdog)
    signal?.removeEventListener('abort', onAbort)
    worker.terminate()
  })
}
