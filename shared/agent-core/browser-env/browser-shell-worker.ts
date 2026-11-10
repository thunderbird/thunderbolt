/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ZenBashFileSystem } from './zen-bash-fs.ts'
import {
  restoreShellError,
  serializeShellError,
  shellFileMethods,
  type ShellFileRequest,
  type ShellHostMessage,
  type ShellOutput,
  type ShellWorkerMessage,
} from './browser-shell-protocol.ts'

export type ShellWorkerFactory = () => Pick<
  Worker,
  'postMessage' | 'terminate' | 'addEventListener' | 'removeEventListener'
>

const createShellWorker: ShellWorkerFactory = () =>
  new Worker(new URL('./browser-shell.worker.ts', import.meta.url), { type: 'module' })
const maxPendingFileOperations = 64

/** Run shell computation off the UI thread while retaining the existing shared, jailed filesystem. */
export const runBrowserShell = async (options: {
  command: string
  cwd: string
  env: Record<string, string>
  fs: ZenBashFileSystem
  signal: AbortSignal
  createWorker?: ShellWorkerFactory
}): Promise<ShellOutput> => {
  options.signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = (options.createWorker ?? createShellWorker)()
    const files = new Map<number, Promise<void>>()
    let finished = false
    const post = (message: ShellHostMessage) => worker.postMessage(message)
    const finish = async (result: ShellOutput | Error) => {
      if (finished) {
        return
      }
      finished = true
      options.signal.removeEventListener('abort', onAbort)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onMessageError)
      worker.terminate()
      // A dispatched filesystem write may already be underway. Drain it before another tool starts.
      await Promise.allSettled(files.values())
      if (result instanceof Error) {
        reject(result)
      } else {
        resolve(result)
      }
    }
    const onAbort = () =>
      void finish(options.signal.reason instanceof Error ? options.signal.reason : new Error('Command aborted'))
    const onError = (event: ErrorEvent) => {
      event.preventDefault()
      void finish(new Error(event.message || 'Browser shell worker failed to start'))
    }
    const onMessageError = () => void finish(new Error('Browser shell worker sent an unreadable response'))
    const serveFile = async (request: ShellFileRequest) => {
      try {
        // The allowlist is checked before lookup; no constructor/prototype or unjailed host API is exposed.
        const method = options.fs[request.method] as (...args: unknown[]) => Promise<unknown>
        const value = await method.apply(options.fs, request.args)
        if (!finished) {
          post({ type: 'fs-result', id: request.id, ok: true, value })
        }
      } catch (error) {
        if (!finished) {
          post({ type: 'fs-result', id: request.id, ok: false, error: serializeShellError(error) })
        }
      } finally {
        files.delete(request.id)
      }
    }
    const onMessage = ({ data }: MessageEvent<ShellWorkerMessage>) => {
      if (finished) {
        return
      }
      if (data.type === 'result') {
        void finish(data.result)
        return
      }
      if (data.type === 'error') {
        void finish(restoreShellError(data.error))
        return
      }
      if (
        data.type !== 'fs' ||
        !shellFileMethods.includes(data.method) ||
        !Number.isSafeInteger(data.id) ||
        files.has(data.id) ||
        files.size >= maxPendingFileOperations
      ) {
        void finish(new Error('Browser shell worker exceeded its filesystem request boundary'))
        return
      }
      const request = serveFile(data)
      files.set(data.id, request)
      void request.catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))))
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.addEventListener('messageerror', onMessageError)
    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      options.signal.throwIfAborted()
      post({ type: 'start', command: options.command, cwd: options.cwd, env: options.env })
    } catch (error) {
      void finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
