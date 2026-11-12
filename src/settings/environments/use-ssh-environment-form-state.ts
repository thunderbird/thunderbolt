/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useTransition } from 'react'
import { useLingui } from '@lingui/react/macro'
import { invoke } from '@tauri-apps/api/core'
import { queryClient } from '@/lib/query-client'
import { useAsyncAttempt } from '@/hooks/use-async-attempt'
import {
  sshConnection,
  validateSshEnvironment,
  useSshEnvironmentsStore,
  type SshEnvironment,
} from '@/agent-execution/ssh-environments'

type FormState = {
  id: string
  name: string
  host: string
  username: string
  port: string
  identityFile: string
  cwd: string
  authentication: SshEnvironment['authentication']
  secret: string
  clearSavedSecret: boolean
  error: string | null
  errorDetail: string | null
}
type FormField = Exclude<keyof FormState, 'id' | 'error' | 'authentication' | 'clearSavedSecret' | 'errorDetail'>
type FormAction =
  | { field: FormField; value: string }
  | { field: 'authentication'; value: FormState['authentication'] }
  | { field: 'error' | 'errorDetail'; value: string | null }
  | { field: 'clearSavedSecret'; value: boolean }

/** Initialize a draft without ever retrieving a previously saved credential. */
const initialState = (environment?: SshEnvironment): FormState => ({
  id: environment?.id ?? crypto.randomUUID(),
  name: environment?.name ?? '',
  host: environment?.host ?? '',
  username: environment?.username ?? '',
  port: environment?.port?.toString() ?? '',
  identityFile: environment?.identityFile ?? '',
  cwd: environment?.cwd ?? '~',
  authentication: environment?.authentication ?? 'agent',
  secret: '',
  clearSavedSecret: false,
  error: null,
  errorDetail: null,
})

/** Keep form secrets in component memory and write them only through native secure storage. */
export const useSshEnvironmentFormState = (environment: SshEnvironment | undefined, onSaved: () => void) => {
  const { t } = useLingui()
  const [state, dispatch] = useReducer(
    (previous: FormState, action: FormAction): FormState => ({
      ...previous,
      [action.field]: action.value,
      ...(action.field === 'authentication' ? { secret: '', clearSavedSecret: false } : {}),
    }),
    environment,
    initialState,
  )
  const [pending, startTransition] = useTransition()
  const submission = useAsyncAttempt()
  const connectionChanged =
    !environment ||
    state.host.trim() !== environment.host ||
    state.username.trim() !== (environment.username ?? '') ||
    (state.port ? Number(state.port) : undefined) !== environment.port ||
    state.authentication !== environment.authentication ||
    (state.authentication === 'key' && state.identityFile.trim() !== environment.identityFile)
  const secretRequired = state.authentication === 'password' && (connectionChanged || !environment?.hasSecret)
  const portValid = !state.port || (/^\d+$/.test(state.port) && Number(state.port) >= 1 && Number(state.port) <= 65535)
  const valid = Boolean(
    state.name.trim() &&
    state.host.trim() &&
    state.cwd.trim() &&
    portValid &&
    (state.authentication !== 'key' || state.identityFile.trim()) &&
    (!secretRequired || state.secret),
  )
  const submit = () =>
    startTransition(async () => {
      if (!valid) {
        return
      }
      const attempt = submission.begin()
      if (!attempt) {
        return
      }
      dispatch({ field: 'error', value: null })
      dispatch({ field: 'errorDetail', value: null })
      try {
        const next = validateSshEnvironment({
          id: state.id,
          name: state.name.trim(),
          host: state.host.trim(),
          username: state.username.trim() || undefined,
          port: state.port ? Number(state.port) : undefined,
          identityFile: state.authentication === 'key' ? state.identityFile.trim() : undefined,
          cwd: state.cwd.trim(),
          authentication: state.authentication,
          deletedAt: null,
          hasSecret: Boolean(state.secret || (!connectionChanged && !state.clearSavedSecret && environment?.hasSecret)),
        })
        if (state.secret || state.clearSavedSecret || (connectionChanged && environment?.hasSecret)) {
          await invoke('agent_ssh_set_secret', { connection: sshConnection(next), secret: state.secret || null })
        }
        useSshEnvironmentsStore.getState().saveEnvironment(next)
        if (connectionChanged || state.secret || state.clearSavedSecret) {
          useSshEnvironmentsStore.getState().clearConnectionStatus(next.id)
          void queryClient.resetQueries({ queryKey: ['ssh-environment-status', JSON.stringify(sshConnection(next))] })
        }
        if (attempt.isCurrent()) {
          dispatch({ field: 'secret', value: '' })
          onSaved()
        }
      } catch (cause) {
        if (attempt.isCurrent()) {
          dispatch({ field: 'errorDetail', value: String(cause) })
          dispatch({
            field: 'error',
            value: t`Could not save the SSH environment. Check the connection fields and try again.`,
          })
        }
      } finally {
        attempt.finish()
      }
    })
  return { ...state, dispatch, pending, valid, secretRequired, connectionChanged, submit }
}
