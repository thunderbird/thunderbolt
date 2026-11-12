/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { NativeInvoke } from '@shared/agent-core/native-execution-env'
import type { SshConnection, SshRequest } from '@shared/agent-core/ssh-transport'
import { sshConnection, useSshEnvironmentsStore } from './ssh-environments'

/** Bind a turn to its original destination, cancelling in-flight requests if that profile is removed or retargeted. */
export const createSshInvoke = (connection: SshConnection, invoke: NativeInvoke): NativeInvoke => {
  const identity = JSON.stringify(connection)
  const isCurrent = () => {
    const environment = useSshEnvironmentsStore.getState().environments[connection.environmentId]
    return Boolean(environment && !environment.deletedAt && JSON.stringify(sshConnection(environment)) === identity)
  }
  return async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    if (command !== 'agent_ssh_request') {
      return invoke<T>(command, args)
    }
    const request = args.request as SshRequest
    if (request.operation === 'cleanup' && !isCurrent()) {
      return invoke<T>(command, { ...args, request: { ...request, forgetOnly: true } })
    }
    if (!isCurrent()) {
      throw new Error('The SSH environment changed or was removed. Stop this turn before using its updated connection.')
    }
    const observedStatus = useSshEnvironmentsStore.getState().connectionStatuses[connection.environmentId]
    const state = { changed: false }
    const unsubscribe = useSshEnvironmentsStore.subscribe(() => {
      if (!state.changed && !isCurrent()) {
        state.changed = true
        void invoke('agent_cancel_command', { id: args.id }).catch(console.error)
      }
    })
    try {
      const result = await invoke<T>(command, args)
      if (state.changed) {
        throw new Error(
          'The SSH environment changed while this operation was running. Its outcome may be incomplete; do not retry automatically.',
        )
      }
      // Cleanup may only release local bookkeeping; a stopped command need not have reached the host.
      if (
        request.operation !== 'cleanup' &&
        !(result && typeof result === 'object' && 'failure' in result && result.failure)
      ) {
        useSshEnvironmentsStore.getState().recordConnectionStatus(connection, 'connected')
      }
      return result
    } catch (error) {
      if (String(error).includes('SSH connection failed:') || String(error).includes('Could not start SSH.')) {
        useSshEnvironmentsStore.getState().recordConnectionStatus(connection, 'disconnected', observedStatus)
      }
      throw error
    } finally {
      unsubscribe()
    }
  }
}
