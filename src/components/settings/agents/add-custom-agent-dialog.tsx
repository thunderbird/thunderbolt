/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ResponsiveModalContentComposable,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { Dialog } from '@/components/ui/dialog'
import { StatusCard } from '@/components/ui/status-card'
import { getPlatform, isTauri } from '@/lib/platform'
import { testAcpConnection as defaultTestAcpConnection } from '@/acp'

/** Maps a user-entered URL to the ACP transport flavor we support, or `null`
 *  when the scheme is unsupported (or the URL is malformed). WebSocket is the
 *  only supported remote transport — HTTP/HTTPS endpoints are rejected. */
export const inferTransport = (url: string): 'websocket' | null => {
  try {
    const u = new URL(url)
    if (u.protocol === 'ws:' || u.protocol === 'wss:') {
      return 'websocket'
    }
    return null
  } catch {
    return null
  }
}

/** True when running on iOS via Tauri — Apple's App Transport Security rejects
 *  cleartext (`ws://`) by default, so we surface a clear error upfront instead
 *  of letting the connection silently fail. */
const defaultIsTauriIOS = (): boolean => isTauri() && getPlatform() === 'ios'

/** Pure validation of `url` against the platform's transport rules. Returns
 *  the inferred transport on success, or a user-facing error string. Extracted
 *  so the test suite can exercise it without rendering the dialog. */
export const validateAgentUrl = (
  url: string,
  isIos: () => boolean = defaultIsTauriIOS,
): { transport: 'websocket' } | { error: string } => {
  const transport = inferTransport(url)
  if (!transport) {
    return { error: 'Only WebSocket endpoints are supported (wss:// or ws://)' }
  }
  if (isIos() && new URL(url).protocol === 'ws:') {
    return { error: 'iOS requires a secure URL (wss://)' }
  }
  return { transport }
}

export type AddCustomAgentPayload = {
  name: string
  url: string
  description: string | null
  transport: 'websocket'
}

/** Async probe signature the dialog uses to test a remote agent endpoint.
 *  Production wires the real `testAcpConnection`; tests inject a stub. */
export type TestAcpConnectionFn = (opts: {
  url: string
}) => Promise<{ success: true } | { success: false; error: string }>

type AddCustomAgentDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (payload: AddCustomAgentPayload) => Promise<void> | void
  /** Test/DI override for the iOS guard. Production callers omit this. */
  isIos?: () => boolean
  /** Test/DI override for the connection probe. Production callers omit this. */
  testAcpConnection?: TestAcpConnectionFn
}

type AgentDialogState = {
  name: string
  url: string
  description: string
  submitting: boolean
  isTestingConnection: boolean
  connectionStatus: 'idle' | 'success' | 'error'
  connectionError: string | null
}

type AgentDialogAction =
  | { type: 'SET_NAME'; value: string }
  | { type: 'SET_URL'; value: string }
  | { type: 'SET_DESCRIPTION'; value: string }
  | { type: 'START_SUBMIT' }
  | { type: 'END_SUBMIT' }
  | { type: 'START_CONNECTION_TEST' }
  | { type: 'CONNECTION_TEST_SUCCESS' }
  | { type: 'CONNECTION_TEST_FAILURE'; error: string }
  | { type: 'RESET' }

const initialState: AgentDialogState = {
  name: '',
  url: '',
  description: '',
  submitting: false,
  isTestingConnection: false,
  connectionStatus: 'idle',
  connectionError: null,
}

const agentDialogReducer = (state: AgentDialogState, action: AgentDialogAction): AgentDialogState => {
  switch (action.type) {
    case 'SET_NAME':
      return { ...state, name: action.value }
    case 'SET_URL':
      // Editing the URL invalidates any prior connection result — the user is
      // targeting a (potentially) different endpoint, so Add must be re-gated.
      return { ...state, url: action.value, connectionStatus: 'idle', connectionError: null }
    case 'SET_DESCRIPTION':
      return { ...state, description: action.value }
    case 'START_SUBMIT':
      return { ...state, submitting: true }
    case 'END_SUBMIT':
      return { ...state, submitting: false }
    case 'START_CONNECTION_TEST':
      return { ...state, isTestingConnection: true, connectionStatus: 'idle', connectionError: null }
    case 'CONNECTION_TEST_SUCCESS':
      return { ...state, isTestingConnection: false, connectionStatus: 'success' }
    case 'CONNECTION_TEST_FAILURE':
      return { ...state, isTestingConnection: false, connectionStatus: 'error', connectionError: action.error }
    case 'RESET':
      return initialState
    default:
      return state
  }
}

export const AddCustomAgentDialog = ({
  open,
  onOpenChange,
  onSubmit,
  isIos,
  testAcpConnection = defaultTestAcpConnection,
}: AddCustomAgentDialogProps) => {
  const [state, dispatch] = useReducer(agentDialogReducer, initialState)

  const trimmedName = state.name.trim()
  const trimmedUrl = state.url.trim()
  const trimmedDescription = state.description.trim()
  const validation = validateAgentUrl(trimmedUrl, isIos)
  // Surface an invalid-URL error at render time (once the field is non-empty)
  // so the user sees why Test Connection is unavailable and Add stays gated.
  const urlError = trimmedUrl.length > 0 && 'error' in validation ? validation.error : null
  // Add is gated behind a successful Test Connection — a valid name, URL, and a
  // confirmed connection are all required before the agent can be created.
  const canSubmit =
    trimmedName.length > 0 && trimmedUrl.length > 0 && state.connectionStatus === 'success' && !state.submitting
  // The probe is only meaningful once the URL is a valid WebSocket endpoint.
  const canTestConnection = trimmedUrl.length > 0 && !urlError

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      dispatch({ type: 'RESET' })
    }
    onOpenChange(next)
  }

  const handleTestConnection = async () => {
    dispatch({ type: 'START_CONNECTION_TEST' })
    const result = await testAcpConnection({ url: trimmedUrl })
    if (result.success) {
      dispatch({ type: 'CONNECTION_TEST_SUCCESS' })
      return
    }
    dispatch({ type: 'CONNECTION_TEST_FAILURE', error: result.error })
  }

  const handleSubmit = async () => {
    // `canSubmit` already requires a successful connection test, which is only
    // reachable for a valid WebSocket URL — so `validation` carries a transport.
    if (!canSubmit || 'error' in validation) {
      return
    }
    dispatch({ type: 'START_SUBMIT' })
    await onSubmit({
      name: trimmedName,
      url: trimmedUrl,
      description: trimmedDescription.length > 0 ? trimmedDescription : null,
      transport: validation.transport,
    })
    dispatch({ type: 'END_SUBMIT' })
    dispatch({ type: 'RESET' })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveModalContentComposable className="sm:max-w-[500px]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Add Custom Agent</ResponsiveModalTitle>
          <ResponsiveModalDescription>
            Connect a remote agent that speaks the Agent Client Protocol.
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>
        <div className="grid gap-4 pt-4 pb-2">
          <div className="grid gap-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              placeholder="My Agent"
              value={state.name}
              onChange={(e) => dispatch({ type: 'SET_NAME', value: e.target.value })}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-url">URL</Label>
            <Input
              id="agent-url"
              placeholder="wss://example.com/ws"
              value={state.url}
              onChange={(e) => dispatch({ type: 'SET_URL', value: e.target.value })}
              autoComplete="off"
            />
            <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
              WebSocket endpoint for the remote ACP agent
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-description">Description</Label>
            <Input
              id="agent-description"
              placeholder="Optional"
              value={state.description}
              onChange={(e) => dispatch({ type: 'SET_DESCRIPTION', value: e.target.value })}
              autoComplete="off"
            />
          </div>
          {canTestConnection && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={handleTestConnection}
              disabled={state.isTestingConnection}
            >
              {state.isTestingConnection ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Testing Agent...
                </>
              ) : (
                'Test Connection'
              )}
            </Button>
          )}
          {state.connectionStatus === 'success' && (
            <StatusCard
              title={
                <>
                  <Check className="h-5 w-5 text-green-600" />
                  Connection successful!
                </>
              }
              description="Successfully connected to the agent."
              className="border-green-200/50 dark:border-green-500/20"
            />
          )}
          {state.connectionStatus === 'error' && (
            <StatusCard
              title={
                <>
                  <X className="h-5 w-5 text-red-600" />
                  Connection failed
                </>
              }
              description={state.connectionError || 'Could not connect to the agent.'}
              className="bg-red-50/50 dark:bg-red-500/10 border-red-200/50 dark:border-red-500/20"
            />
          )}
          {urlError && (
            <p role="alert" className="text-[length:var(--font-size-sm)] text-destructive">
              {urlError}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            Add Agent
          </Button>
        </div>
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
