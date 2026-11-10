/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '../browser-stubs/install-process.ts'
import { Bash, type IFileSystem } from 'just-bash'
import { resolve } from '@zenfs/core/path'
import { ensureBufferPolyfill } from '../ensure-buffer.ts'
import {
  restoreShellError,
  serializeShellError,
  shellFileMethods,
  type ShellFileMethod,
  type ShellHostMessage,
  type ShellWorkerMessage,
} from './browser-shell-protocol.ts'

ensureBufferPolyfill()

// The DOM project also builds this worker; keep its actual message surface explicit.
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<ShellHostMessage>) => void
  postMessage: (message: ShellWorkerMessage) => void
}
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let nextRequest = 0
let started = false

/** Keep the shared OPFS mount in its owning thread; the worker receives only operation results. */
const callFile = (method: ShellFileMethod, args: unknown[]): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = ++nextRequest
    pending.set(id, { resolve, reject })
    scope.postMessage({ type: 'fs', id, method, args })
  })

const files = Object.fromEntries(
  shellFileMethods.map((method) => [method, (...args: unknown[]) => callFile(method, args)]),
) as Pick<IFileSystem, ShellFileMethod>
const fs: IFileSystem = { ...files, resolvePath: resolve, getAllPaths: () => [] }

/** Execute exactly one command; the host terminates this worker on completion, Stop, or timeout. */
const execute = async (message: Extract<ShellHostMessage, { type: 'start' }>): Promise<void> => {
  try {
    // No JS/python/network capabilities are enabled. Isolation is the worker plus the jailed host FS.
    const bash = new Bash({ fs, cwd: message.cwd, env: message.env, defenseInDepth: false })
    const { stdout, stderr, exitCode } = await bash.exec(message.command)
    scope.postMessage({ type: 'result', result: { stdout, stderr, exitCode } })
  } catch (error) {
    scope.postMessage({ type: 'error', error: serializeShellError(error) })
  }
}

scope.onmessage = ({ data }) => {
  if (data.type === 'start') {
    if (!started) {
      started = true
      void execute(data)
    }
    return
  }
  const request = pending.get(data.id)
  if (!request) {
    return
  }
  pending.delete(data.id)
  if (data.ok) {
    request.resolve(data.value)
  } else {
    request.reject(restoreShellError(data.error))
  }
}
