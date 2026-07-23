/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { StatusCard } from '@/components/ui/status-card'
import { testAcpConnection as defaultTestAcpConnection } from '@/acp'
import { irohClientNodeId } from '@/acp/iroh/iroh-transport'
import { IrohPairingPanel, useAppNodeId } from '@/components/settings/iroh-pairing-panel'
import { validateAgentUrl } from '@/components/settings/agents/validate-agent-url'
import type { CustomAgentTransport } from '@/dal/agents'

export type AddCustomAgentPayload = {
  name: string
  url: string
  description: string | null
  transport: CustomAgentTransport
}

/** Async probe signature the form uses to test a remote agent endpoint.
 *  Production wires the real `testAcpConnection`; tests inject a stub. */
export type TestAcpConnectionFn = (opts: {
  url: string
}) => Promise<{ success: true } | { success: false; error: string }>

type AddCustomAgentFormProps = {
  onClose: () => void
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

type AgentFormState = {
  name: string
  url: string
  description: string
  submitting: boolean
  /** Save failed after the connection gate — shown next to the buttons. */
  submitError: string | null
  isTestingConnection: boolean
  connectionStatus: 'idle' | 'success' | 'error'
  connectionError: string | null
}

/** User-meaningful form events; the reducer maps each to a state delta. */
type AgentFormAction =
  | { type: 'NAME_CHANGED'; value: string }
  | { type: 'URL_CHANGED'; value: string }
  | { type: 'DESCRIPTION_CHANGED'; value: string }
  | { type: 'SUBMIT_STARTED' }
  | { type: 'SUBMIT_FAILED'; message: string }
  | { type: 'CONNECTION_TEST_STARTED' }
  | { type: 'CONNECTION_TEST_SUCCEEDED' }
  | { type: 'CONNECTION_TEST_FAILED'; error: string }

const emptyState: AgentFormState = {
  name: '',
  url: '',
  description: '',
  submitting: false,
  submitError: null,
  isTestingConnection: false,
  connectionStatus: 'idle',
  connectionError: null,
}

const agentFormReducer = (state: AgentFormState, action: AgentFormAction): AgentFormState => {
  switch (action.type) {
    case 'NAME_CHANGED':
      return { ...state, name: action.value }
    case 'URL_CHANGED':
      // Editing the URL invalidates any prior connection result — the user is
      // targeting a (potentially) different endpoint, so submit must be re-gated.
      return { ...state, url: action.value, connectionStatus: 'idle', connectionError: null }
    case 'DESCRIPTION_CHANGED':
      return { ...state, description: action.value }
    case 'SUBMIT_STARTED':
      return { ...state, submitting: true, submitError: null }
    case 'SUBMIT_FAILED':
      return { ...state, submitting: false, submitError: action.message }
    case 'CONNECTION_TEST_STARTED':
      return { ...state, isTestingConnection: true, connectionStatus: 'idle', connectionError: null }
    case 'CONNECTION_TEST_SUCCEEDED':
      return { ...state, isTestingConnection: false, connectionStatus: 'success' }
    case 'CONNECTION_TEST_FAILED':
      return { ...state, isTestingConnection: false, connectionStatus: 'error', connectionError: action.error }
  }
}

export const AddCustomAgentForm = ({
  onClose,
  onSubmit,
  isIos,
  testAcpConnection = defaultTestAcpConnection,
  loadAppNodeId = irohClientNodeId,
}: AddCustomAgentFormProps) => {
  const [state, dispatch] = useReducer(agentFormReducer, emptyState)

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

  const handleTestConnection = async () => {
    dispatch({ type: 'CONNECTION_TEST_STARTED' })
    const result = await testAcpConnection({ url: trimmedUrl })
    if (result.success) {
      dispatch({ type: 'CONNECTION_TEST_SUCCEEDED' })
      return
    }
    dispatch({ type: 'CONNECTION_TEST_FAILED', error: result.error })
  }

  const handleSubmit = async () => {
    // `canSubmit` is only true once `validation` resolves to a transport (a tested
    // WebSocket endpoint or a valid iroh target), so this guard is belt-and-braces
    // and also narrows the union for `validation.transport` below.
    if (!canSubmit || 'error' in validation) {
      return
    }
    dispatch({ type: 'SUBMIT_STARTED' })
    try {
      await onSubmit({
        name: trimmedName,
        url: trimmedUrl,
        description: trimmedDescription.length > 0 ? trimmedDescription : null,
        transport: validation.transport,
      })
    } catch (error) {
      // Keep the form intact so the user can retry — and say why nothing happened.
      console.error('Failed to add custom agent', error)
      dispatch({ type: 'SUBMIT_FAILED', message: "Couldn't add the agent. Please try again." })
      return
    }
    // The parent unmounts the form on close, so state resets by remount.
    onClose()
  }

  // Renders as plain panel content — the agents page hosts it inside the
  // shared DetailPanelSurface (same aside idiom as the skills create form),
  // which owns the "Add custom agent" header and close affordance.
  return (
    <div className="flex flex-1 flex-col">
      <p className="text-sm text-muted-foreground">Connect a remote agent that speaks the Agent Client Protocol.</p>
      <div className="grid grid-cols-1 gap-4 pt-4 pb-2">
        <div className="grid grid-cols-1 gap-2">
          <Label htmlFor="agent-name">Name</Label>
          <Input
            id="agent-name"
            placeholder="My Agent"
            value={state.name}
            onChange={(e) => dispatch({ type: 'NAME_CHANGED', value: e.target.value })}
            autoComplete="off"
          />
        </div>
        <div className="grid grid-cols-1 gap-2">
          <Label htmlFor="agent-url">URL</Label>
          <Input
            id="agent-url"
            placeholder="wss://example.com/ws or paste an iroh ticket"
            value={state.url}
            onChange={(e) => dispatch({ type: 'URL_CHANGED', value: e.target.value })}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
            A WebSocket endpoint, or paste an iroh ticket from your bridge for a peer-to-peer connection (a bare NodeId
            works only if the peer is discoverable).
          </p>
        </div>
        {isIroh && <IrohPairingPanel appNodeId={appNodeId} />}
        <div className="grid grid-cols-1 gap-2">
          <Label htmlFor="agent-description">Description</Label>
          <Input
            id="agent-description"
            placeholder="Optional"
            value={state.description}
            onChange={(e) => dispatch({ type: 'DESCRIPTION_CHANGED', value: e.target.value })}
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
                Testing agent…
              </>
            ) : (
              'Test connection'
            )}
          </Button>
        )}
        {state.connectionStatus === 'success' && (
          <StatusCard
            icon={<Check className="h-4 w-4 text-success" />}
            title="Connection successful!"
            description="Successfully connected to the agent."
          />
        )}
        {state.connectionStatus === 'error' && (
          <StatusCard
            icon={<X className="h-4 w-4 text-destructive" />}
            title="Connection failed"
            description={state.connectionError || 'Could not connect to the agent.'}
          />
        )}
        {urlError && (
          <p role="alert" className="text-[length:var(--font-size-sm)] text-destructive">
            {urlError}
          </p>
        )}
      </div>
      <FormFooter>
        {state.submitError && (
          <p role="alert" className="min-w-0 flex-1 truncate text-[length:var(--font-size-sm)] text-destructive">
            {state.submitError}
          </p>
        )}
        <ResponsiveModalCancel onClick={onClose} />
        <Button onClick={handleSubmit} disabled={!canSubmit}>
          Add agent
        </Button>
      </FormFooter>
    </div>
  )
}
