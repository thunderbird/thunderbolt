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
import { irohClientNodeId } from '@/acp/iroh/iroh-transport'
import { IrohPairingPanel, useAppNodeId } from '@/components/settings/iroh-pairing-panel'
import { isIrohTarget } from '@/lib/iroh-target'
import type { CustomAgentTransport } from '@/dal/agents'

/** Maps a user-entered endpoint to the ACP transport flavor we support, or `null`
 *  when it is neither a `ws(s)://` URL nor an iroh NodeId/ticket. HTTP/HTTPS and
 *  other schemes are rejected. */
export const inferTransport = (url: string): CustomAgentTransport | null => {
  if (isIrohTarget(url)) {
    return 'iroh'
  }
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
): { transport: CustomAgentTransport } | { error: string } => {
  const transport = inferTransport(url)
  if (!transport) {
    return { error: 'Enter a wss:// URL or an iroh ticket' }
  }
  // iroh dials QUIC over an encrypted relay (no cleartext) and its target isn't a
  // URL, so the iOS ATS guard only applies to a `ws://` WebSocket endpoint.
  if (transport === 'websocket' && isIos() && new URL(url).protocol === 'ws:') {
    return { error: 'iOS requires a secure URL (wss://)' }
  }
  return { transport }
}

export type AddCustomAgentPayload = {
  name: string
  url: string
  description: string | null
  transport: CustomAgentTransport
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
  /** Test/DI override for reading this app's iroh client NodeId — the value a
   *  bridge operator allowlists. Production omits and lazy-loads the wasm client
   *  (only when the user enters an iroh target, so the wasm chunk stays lazy). */
  loadAppNodeId?: () => Promise<string>
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
  | { type: 'RESET'; next: AgentDialogState }

const emptyState: AgentDialogState = {
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
      // targeting a (potentially) different endpoint, so submit must be re-gated.
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
      return action.next
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
  loadAppNodeId = irohClientNodeId,
}: AddCustomAgentDialogProps) => {
  const [state, dispatch] = useReducer(agentDialogReducer, emptyState)

  const trimmedName = state.name.trim()
  const trimmedUrl = state.url.trim()
  const trimmedDescription = state.description.trim()
  const validation = validateAgentUrl(trimmedUrl, isIos)
  // Surface an invalid-target error at render time (once the field is non-empty)
  // so the user sees why submit stays gated.
  const urlError = trimmedUrl.length > 0 && 'error' in validation ? validation.error : null
  const transport = 'error' in validation ? null : validation.transport
  const isIroh = transport === 'iroh'
  // A WebSocket endpoint is probed before save. An iroh bridge must first
  // allowlist THIS app's NodeId out-of-band (`thunderbolt iroh allow <id>`), so a
  // pre-allowlist probe would always fail — iroh is gated on a valid target alone
  // and verified on the first chat instead.
  const requiresConnectionTest = transport === 'websocket'
  const connectionReady = requiresConnectionTest ? state.connectionStatus === 'success' : isIroh
  const canSubmit = trimmedName.length > 0 && connectionReady && !state.submitting
  // The probe is only meaningful for a valid WebSocket endpoint.
  const canTestConnection = requiresConnectionTest && trimmedUrl.length > 0 && !urlError

  // Load this app's iroh NodeId once the user targets an iroh bridge, so it can be
  // shown for allowlisting. The shared hook keeps the wasm chunk lazy (loads only
  // while an iroh target is selected) and re-arms when the target is re-entered.
  const appNodeId = useAppNodeId(isIroh, loadAppNodeId)

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      // On close, reset so a reopen without remount lands in a predictable shape.
      dispatch({ type: 'RESET', next: emptyState })
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
    // `canSubmit` is only true once `validation` resolves to a transport (a tested
    // WebSocket endpoint or a valid iroh target), so this guard is belt-and-braces
    // and also narrows the union for `validation.transport` below.
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
    dispatch({ type: 'RESET', next: emptyState })
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
        <div className="grid grid-cols-1 gap-4 pt-4 pb-2">
          <div className="grid grid-cols-1 gap-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              placeholder="My Agent"
              value={state.name}
              onChange={(e) => dispatch({ type: 'SET_NAME', value: e.target.value })}
              autoComplete="off"
            />
          </div>
          <div className="grid grid-cols-1 gap-2">
            <Label htmlFor="agent-url">URL</Label>
            <Input
              id="agent-url"
              placeholder="wss://example.com/ws or paste an iroh ticket"
              value={state.url}
              onChange={(e) => dispatch({ type: 'SET_URL', value: e.target.value })}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
              A WebSocket endpoint, or paste an iroh ticket from your bridge for a peer-to-peer connection (a bare
              NodeId works only if the peer is discoverable).
            </p>
          </div>
          {isIroh && <IrohPairingPanel appNodeId={appNodeId} />}
          <div className="grid grid-cols-1 gap-2">
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
