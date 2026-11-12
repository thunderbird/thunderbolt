/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { NativeInvoke } from './native-execution-env.ts'

export type SshConnection = {
  environmentId: string
  host: string
  username?: string
  port?: number
  identityFile?: string
  authentication: 'agent' | 'key' | 'password'
  hasSecret?: boolean
}

export type SshRequest = {
  operation: 'probe' | 'list_directories' | 'resolve' | 'read' | 'write' | 'restore' | 'temp' | 'cleanup' | 'exec'
  cwd: string
  owner: string
  path?: string
  content?: number[]
  prefix?: string
  suffix?: string
  command?: string
  env?: Record<string, string>
  timeout?: number
  forgetOnly?: boolean
}

export type SshDirectoryListing = {
  path: string
  parentPath: string | null
  directories: Array<{ name: string; path: string }>
}

/** Register cancellation before starting SSH, including for filesystem operations. Never retry side effects. */
export const invokeSshRequest = async <T>(
  invoke: NativeInvoke,
  connection: SshConnection,
  request: SshRequest,
  signal?: AbortSignal,
): Promise<T> => {
  signal?.throwIfAborted()
  const id = crypto.randomUUID()
  const cancel = () => {
    void invoke('agent_cancel_command', { id }).catch(console.error)
  }
  try {
    await invoke('agent_prepare_command', { id })
    signal?.addEventListener('abort', cancel, { once: true })
    signal?.throwIfAborted()
    return await invoke<T>('agent_ssh_request', { id, connection, request })
  } finally {
    signal?.removeEventListener('abort', cancel)
    await invoke('agent_forget_command', { id }).catch(console.error)
  }
}
