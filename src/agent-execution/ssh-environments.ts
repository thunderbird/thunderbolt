/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { z } from 'zod'
import type { SshConnection } from '@shared/agent-core/ssh-transport'

const sshEnvironmentSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    host: z
      .string()
      .max(253)
      .regex(/^(?!-)[a-zA-Z0-9._:[\]%-]+$/),
    username: z
      .string()
      .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/)
      .optional(),
    port: z.number().int().min(1).max(65535).optional(),
    identityFile: z
      .string()
      .min(1)
      .refine((value) => !/\p{Cc}/u.test(value))
      .optional(),
    cwd: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !/\p{Cc}/u.test(value)),
    authentication: z.enum(['agent', 'key', 'password']),
    hasSecret: z.boolean().optional(),
    deletedAt: z.string().nullable(),
  })
  .refine((value) => value.authentication !== 'key' || Boolean(value.identityFile), {
    message: 'Choose a private key file',
    path: ['identityFile'],
  })

export type SshEnvironment = z.infer<typeof sshEnvironmentSchema>

export type SshConnectionStatus = {
  connectionKey: string
  status: 'connected' | 'disconnected'
  checkedAt: number
}

/** Validate the complete profile before writing either connection metadata or its secure credential. */
export const validateSshEnvironment = (environment: SshEnvironment): SshEnvironment =>
  sshEnvironmentSchema.parse(environment)

type SshEnvironmentsState = {
  environments: Record<string, SshEnvironment>
  connectionStatuses: Record<string, SshConnectionStatus>
  /** Failures need the status observed before the request; newer connection evidence takes precedence. */
  recordConnectionStatus: (
    connection: SshConnection,
    status: SshConnectionStatus['status'],
    observedStatus?: SshConnectionStatus,
  ) => void
  clearConnectionStatus: (id: string) => void
  saveEnvironment: (environment: SshEnvironment) => void
  deleteEnvironment: (id: string) => void
}

/** Local connection metadata only. Passwords/passphrases live in the operating system credential store. */
export const useSshEnvironmentsStore = create<SshEnvironmentsState>()(
  persist(
    (set) => ({
      environments: {},
      connectionStatuses: {},
      recordConnectionStatus: (connection, status, observedStatus) =>
        set((state) => {
          const environment = state.environments[connection.environmentId]
          if (!environment || environment.deletedAt || !matchesSshConnection(sshConnection(environment), connection)) {
            return state
          }
          const connectionKey = JSON.stringify(sshConnection(environment))
          // A request started before newer evidence cannot turn that connection red.
          if (status === 'disconnected' && state.connectionStatuses[environment.id] !== observedStatus) {
            return state
          }
          return {
            connectionStatuses: {
              ...state.connectionStatuses,
              [environment.id]: { connectionKey, status, checkedAt: Date.now() },
            },
          }
        }),
      clearConnectionStatus: (id) =>
        set((state) => ({
          connectionStatuses: Object.fromEntries(
            Object.entries(state.connectionStatuses).filter(([key]) => key !== id),
          ),
        })),
      saveEnvironment: (environment) => {
        const validated = validateSshEnvironment(environment)
        set((state) => ({
          environments: { ...state.environments, [validated.id]: validated },
        }))
      },
      deleteEnvironment: (id) =>
        set((state) => {
          const environment = state.environments[id]
          if (!environment || environment.deletedAt) {
            return state
          }
          return {
            environments: { ...state.environments, [id]: { ...environment, deletedAt: new Date().toISOString() } },
          }
        }),
    }),
    {
      name: 'thunderbolt-ssh-environments-v1',
      partialize: (state) => ({ environments: state.environments, connectionStatuses: state.connectionStatuses }),
    },
  ),
)

/** Resolve the exact saved identity; deleted or missing profiles never become another environment. */
export const getSshEnvironment = (id: string): SshEnvironment => {
  const environment = useSshEnvironmentsStore.getState().environments[id]
  if (!environment || environment.deletedAt) {
    throw new Error('This SSH environment is unavailable on this computer. Configure it in Settings → Environments.')
  }
  return sshEnvironmentSchema.parse(environment)
}

/** Send only transport configuration across IPC; display names and workspace choices are not credentials. */
export const sshConnection = (environment: SshEnvironment): SshConnection => ({
  environmentId: environment.id,
  host: environment.host,
  username: environment.username,
  port: environment.port,
  identityFile: environment.identityFile,
  authentication: environment.authentication,
  hasSecret: environment.hasSecret,
})

/** Compare transport identity independently of persisted JSON property order. */
export const matchesSshConnection = (first: SshConnection | undefined, second: SshConnection | undefined): boolean => {
  if (first === second) {
    return true
  }
  if (!first || !second) {
    return false
  }
  return (
    first.environmentId === second.environmentId &&
    first.host === second.host &&
    first.username === second.username &&
    first.port === second.port &&
    first.identityFile === second.identityFile &&
    first.authentication === second.authentication &&
    first.hasSecret === second.hasSecret
  )
}

/** Refuse delayed work or saved app launches after a profile was removed or retargeted. */
export const isCurrentSshConnection = (connection: SshConnection): boolean => {
  const environment = useSshEnvironmentsStore.getState().environments[connection.environmentId]
  return Boolean(environment && !environment.deletedAt && matchesSshConnection(sshConnection(environment), connection))
}
