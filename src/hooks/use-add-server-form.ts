/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  decideTestConnectionResult,
  type StoredCredentialType,
  type TestConnectionResult,
} from '@/lib/mcp-auth/auth-decision'
import type { classifyMcpServerAuth } from '@/lib/mcp-auth/web-oauth-flow'
import { isUnauthorizedError } from '@/lib/mcp-errors'
import type { probeMcpServerTools } from '@/lib/mcp-connection-test'
import { isIrohTarget } from '@/lib/iroh-target'
import { buildMcpHeaders, createMcpTransport, type MCPTransportType } from '@/lib/mcp-transport'
import { validateMcpServerUrl } from '@/lib/mcp-url-validation'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { McpServer } from '@/types'
import { useEffect, useReducer, useRef } from 'react'

/**
 * Derives a short, meaningful server name from a remote MCP URL — used to
 * pre-fill (and re-derive) the editable name field. The name namespaces the
 * server's tools in the prompt, so a readable default like `github` or `render`
 * beats the raw hostname.
 * - Localhost: includes port for disambiguation (`localhost-3000`)
 * - IP literals (IPv4 dotted-quad or IPv6): kept whole so distinct hosts stay
 *   distinct (`192.168.1.100`, `2001:db8::1`)
 * - Remote: 3+ domain segments → second-to-last (`api.github.com` → `github`);
 *   2 segments → first (`render.com` → `render`); 1 → as-is
 */
export const generateServerName = (url: string): string => {
  try {
    const { hostname, port } = new URL(url)
    // `URL` brackets IPv6 hosts (`[::1]`) and may keep a trailing FQDN dot — normalize both.
    const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return port ? `localhost-${port}` : 'localhost'
    }
    // IP literals (IPv4 dotted-quad or IPv6) have no registrable label to shorten to —
    // use the whole address so distinct hosts stay distinct (sanitizeToolPrefix maps separators to `_`).
    if (host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      return host
    }
    const parts = host.split('.')
    return parts.length >= 3 ? parts[parts.length - 2] : parts[0]
  } catch {
    return ''
  }
}

type AddServerFormState = {
  isAddFormOpen: boolean
  /** Non-null when the form is editing an existing server (id) instead of adding one. */
  editingServerId: string | null
  name: string
  /** True once the user edits the name field, so the URL stops re-deriving it. */
  nameManuallyEdited: boolean
  url: string
  transport: MCPTransportType
  token: string
  /** The stored bearer token loaded at edit-open. Never prefilled into the
   *  token input (the field stays masked/empty); used only when a probe needs
   *  the kept credential. Null in Add mode or when no bearer is stored. */
  storedBearerToken: string | null
  /** True when the user explicitly chose to remove the stored bearer token. */
  isClearingStoredToken: boolean
  isTestingConnection: boolean
  testResult: TestConnectionResult | { kind: 'idle' }
  /** Snapshot of url/transport/credentialType at edit-open. Used to detect
   *  whether the user changed a connection-affecting field, so the Save gate can
   *  skip the fresh-probe requirement on a metadata-only edit (e.g. rename) where
   *  the existing credential — including OAuth — is presumed valid. `credentialType`
   *  additionally lets the gate recognize a "clear bearer" edit, which can save
   *  without a passing probe (removing auth from a still-protected server would
   *  otherwise fail the probe and lock Save out). Null in Add mode. */
  originalConnection: {
    url: string
    transport: MCPTransportType
    credentialType: StoredCredentialType
  } | null
}

type AddServerFormAction =
  | { type: 'FORM_OPENED' }
  | { type: 'EDIT_FORM_OPENED'; server: McpServer; bearerToken: string | null; credentialType: StoredCredentialType }
  | { type: 'FORM_RESET' }
  | { type: 'NAME_CHANGED'; value: string }
  | { type: 'URL_CHANGED'; value: string; derivedName: string | null }
  | { type: 'TRANSPORT_CHANGED'; value: MCPTransportType }
  | { type: 'TOKEN_CHANGED'; value: string }
  | { type: 'CLEAR_STORED_TOKEN_TOGGLED' }
  | { type: 'TEST_INVALIDATED' }
  | { type: 'PROBE_STARTED' }
  | { type: 'PROBE_RESULTED'; result: TestConnectionResult }
  | { type: 'PROBE_SETTLED' }

const initialState: AddServerFormState = {
  isAddFormOpen: false,
  editingServerId: null,
  name: '',
  nameManuallyEdited: false,
  url: '',
  transport: 'http',
  token: '',
  storedBearerToken: null,
  isClearingStoredToken: false,
  isTestingConnection: false,
  testResult: { kind: 'idle' },
  originalConnection: null,
}

const addServerFormReducer = (state: AddServerFormState, action: AddServerFormAction): AddServerFormState => {
  switch (action.type) {
    case 'FORM_OPENED':
      return { ...state, isAddFormOpen: true }
    case 'EDIT_FORM_OPENED': {
      // Edit prefills the metadata fields from the existing row; the stored
      // bearer token deliberately stays OUT of the token input (masked-keep
      // pattern — see `storedBearerToken`). `nameManuallyEdited` is set so a
      // URL change during edit doesn't clobber the existing name.
      const url = action.server.url ?? ''
      const transport: MCPTransportType = action.server.type === 'sse' ? 'sse' : 'http'
      return {
        ...initialState,
        isAddFormOpen: true,
        editingServerId: action.server.id,
        name: action.server.name ?? '',
        nameManuallyEdited: true,
        url,
        transport,
        storedBearerToken: action.bearerToken,
        originalConnection: { url, transport, credentialType: action.credentialType },
      }
    }
    case 'FORM_RESET':
      return initialState
    case 'NAME_CHANGED':
      return { ...state, name: action.value, nameManuallyEdited: true }
    case 'URL_CHANGED':
      // The URL re-derives the name only while the user hasn't edited it manually.
      return { ...state, url: action.value, name: action.derivedName ?? state.name }
    case 'TRANSPORT_CHANGED':
      return { ...state, transport: action.value }
    case 'TOKEN_CHANGED':
      // Typing a replacement supersedes a pending "clear" of the stored token.
      return { ...state, token: action.value, isClearingStoredToken: false }
    case 'CLEAR_STORED_TOKEN_TOGGLED':
      return { ...state, token: '', isClearingStoredToken: !state.isClearingStoredToken }
    case 'TEST_INVALIDATED':
      // Invalidating a test clears both the result and any in-flight flag: a probe
      // is invalidated by bumping `probeIdRef`, which makes its `finally` skip the
      // `PROBE_SETTLED` dispatch, so the flag must be cleared here or the spinner
      // (and the disabled "Test Connection" button) would stay stuck forever.
      return { ...state, isTestingConnection: false, testResult: { kind: 'idle' } }
    case 'PROBE_STARTED':
      return { ...state, isTestingConnection: true, testResult: { kind: 'idle' } }
    case 'PROBE_RESULTED':
      return { ...state, testResult: action.result }
    case 'PROBE_SETTLED':
      return { ...state, isTestingConnection: false }
  }
}

/** The credential a probe should use: a typed replacement wins, else the kept stored bearer. */
const effectiveProbeToken = (state: AddServerFormState): string | undefined => {
  if (state.token) {
    return state.token
  }
  return state.isClearingStoredToken ? undefined : (state.storedBearerToken ?? undefined)
}

/** Test-only DI seams for the add-form probe + OAuth-discovery classification,
 *  plus the proxy-routed fetch builder they share with the live transport. */
export type AddServerFormDeps = {
  probeMcpServerTools: typeof probeMcpServerTools
  classifyMcpServerAuth: typeof classifyMcpServerAuth
  buildOAuthFetch: () => FetchFn
}

export type UseAddServerFormResult = {
  isAddFormOpen: boolean
  /** Id of the server being edited, or null when the form is in Add mode. */
  editingServerId: string | null
  openAddForm: () => void
  /** Opens the form in Edit mode with all fields prefilled from the existing server. */
  openEditForm: (server: McpServer, bearerToken: string | null, credentialType: StoredCredentialType) => void
  /** Closes the form and clears all add-form state (Cancel / Escape / panel close). */
  resetAddForm: () => void
  name: string
  url: string
  /** Effective transport: `iroh` when the URL is a NodeId/ticket, else the
   *  user-selected http/sse. Drives both the UI branch and the stored row. */
  transport: MCPTransportType
  /** True when the URL is an iroh NodeId/ticket — the form shows the pairing
   *  panel and gates Add on a valid target + name (no http probe). */
  isIroh: boolean
  token: string
  /** True when an existing bearer credential is stored for the server being edited. */
  hasStoredBearerToken: boolean
  /** True when the user chose to remove the stored bearer token on save. */
  isClearingStoredToken: boolean
  /** Toggles between clearing and keeping the stored bearer token. */
  toggleClearStoredToken: () => void
  /** Field-change handlers: each first invalidates a stale test result. */
  changeName: (value: string) => void
  changeUrl: (value: string) => void
  changeTransport: (value: MCPTransportType) => void
  changeToken: (value: string) => void
  testResult: TestConnectionResult | { kind: 'idle' }
  isTestingConnection: boolean
  serverCapabilities: string[]
  /** True when a connection-affecting field (url/transport/token) differs from
   *  the value loaded at edit-open. Always true in Add mode (no original
   *  snapshot). Callers gate the Save-Changes test-success requirement on this
   *  so a metadata-only edit can save without re-probing — important for OAuth
   *  servers, whose empty-token probe would classify as `needs-oauth`. */
  hasConnectionEdits: boolean
  /** True when the user's only connection change is clearing the stored bearer
   *  token (URL/transport unchanged). Removing auth from a still-protected
   *  server would fail an unauthenticated probe, which would otherwise leave Save
   *  Changes disabled — so this signals the Save gate can waive the probe
   *  requirement. False in Add mode. */
  isClearingBearerOnly: boolean
  /** True when editing an OAuth-authorized server with the token field still empty
   *  (its normal state — OAuth tokens aren't surfaced in the token input). Any
   *  probe from this state would fail 401 (no bearer), classify as `needs-oauth`,
   *  and lock Save Changes out for a URL/transport edit that would otherwise be
   *  reasonable to persist (the stored OAuth token stays intact via the mutation's
   *  `credentials: undefined` branch, and the card's existing needs-auth flow
   *  handles a re-authorize at the new endpoint). False in Add mode and once the
   *  user types a bearer token (converting the server away from OAuth). */
  isOAuthEdit: boolean
  testConnection: () => Promise<void>
  /** Leaving the URL field probes immediately (unless the debounce already did). */
  handleUrlBlur: () => void
  /** Name prefixes the server's tools in the prompt — user value or URL-derived fallback. */
  resolveServerName: () => string
}

/**
 * Owns the "Add MCP Server" panel form: the field state (name/url/transport/
 * token), the Test Connection probe with its auth classification, and the
 * stale-probe / form-reset bookkeeping. Mirrors `useMcpServerOAuth`'s
 * ergonomics so the page stays a thin consumer — it keeps the submit handlers
 * (`handleAddServer` / `handleAddAndAuthorize`) that tie this form to the
 * server mutation and the OAuth hook, reading the form via the returned getters.
 *
 * @param cloudUrl Proxy origin used to build the transport for the probe.
 * @param deps Injectable probe + classification + proxy-fetch seams (tests override them).
 * @param onClearDialogError Clears the OAuth dialog error (owned by `useMcpServerOAuth`).
 */
export const useAddServerForm = ({
  cloudUrl,
  deps,
  onClearDialogError,
}: {
  cloudUrl: string
  deps: AddServerFormDeps
  onClearDialogError: () => void
}): UseAddServerFormResult => {
  const [state, dispatch] = useReducer(addServerFormReducer, initialState)
  // Auto-detect: monotonic id to ignore a stale in-flight probe once the URL
  // changes mid-flight, plus the last URL value auto-probed so the blur and the
  // debounce don't double-fire for the same value.
  const probeIdRef = useRef(0)
  const lastAutoTestedUrlRef = useRef<string | null>(null)

  const openAddForm = () => dispatch({ type: 'FORM_OPENED' })

  // Open the form with the metadata fields prefilled from an existing server
  // row. The stored bearer token (null for OAuth or no-cred) is retained for
  // probes but never shown in the input. The auto-detect effect will probe the
  // prefilled URL after the standard 700ms debounce, so the user must still
  // pass Test Connection before saving — same gate as Add.
  const openEditForm = (server: McpServer, bearerToken: string | null, credentialType: StoredCredentialType) => {
    probeIdRef.current += 1
    lastAutoTestedUrlRef.current = null
    onClearDialogError()
    dispatch({ type: 'EDIT_FORM_OPENED', server, bearerToken, credentialType })
  }

  // Closes the add form and clears all its state. Bumps the probe id so an
  // in-flight connection probe can't land its result after the form is gone.
  const resetAddForm = () => {
    probeIdRef.current += 1
    dispatch({ type: 'FORM_RESET' })
    onClearDialogError()
    lastAutoTestedUrlRef.current = null
  }

  // Editing any field after a test invalidates that result, so the user can't
  // add a url+transport+token combination that was never tested together. Bumping
  // the probe id first invalidates any in-flight probe (whose result is now stale
  // for the edited value) — this must run before the idle guard, because a probe
  // in flight has already reset testResult to idle.
  const resetConnectionTest = () => {
    onClearDialogError()
    probeIdRef.current += 1
    // Nothing to clear when no probe is in flight and the result is already idle —
    // skip the no-op dispatch (this runs on every keystroke).
    if (!state.isTestingConnection && state.testResult.kind === 'idle') {
      return
    }
    dispatch({ type: 'TEST_INVALIDATED' })
  }

  const testConnection = async () => {
    if (!state.url) {
      return
    }
    // Tag this probe so a slower earlier run can't overwrite a newer one's result
    // (the URL can change while a probe is in flight), and record the tested value
    // so the blur + debounce auto-triggers don't double-probe it.
    const probeId = ++probeIdRef.current
    lastAutoTestedUrlRef.current = state.url
    const probeToken = effectiveProbeToken(state)

    dispatch({ type: 'PROBE_STARTED' })

    try {
      // Build the transport the same way the provider does — through the
      // universal proxy so the test matches the real connection path (web CORS
      // would otherwise fail for remote servers).
      const headers = buildMcpHeaders(probeToken)
      const transport = createMcpTransport(state.url, state.transport, cloudUrl, headers)

      const toolNames = await deps.probeMcpServerTools(transport)
      if (probeIdRef.current !== probeId) {
        return
      }
      dispatch({ type: 'PROBE_RESULTED', result: { kind: 'success', tools: toolNames } })
    } catch (error) {
      // A 401 here is the OAuth/credential probe signal, not a failure — keep it at warn.
      console.warn('Connection test error:', error)
      // Auth precedence: a supplied credential that 401s is a rejected token (no
      // Authorize). An empty-credential 401 classifies the server: 'authorizable'
      // (DCR/CIMD → Add & Authorize), 'token-only' (OAuth advertised but no usable
      // registration, e.g. GitHub → ask for a static token), or 'none'.
      const oauthActionability =
        !probeToken && isUnauthorizedError(error)
          ? await deps.classifyMcpServerAuth(state.url, deps.buildOAuthFetch())
          : 'none'
      if (probeIdRef.current !== probeId) {
        return
      }
      dispatch({
        type: 'PROBE_RESULTED',
        result: decideTestConnectionResult({ hasCredential: !!probeToken, error, oauthActionability }),
      })
    } finally {
      if (probeIdRef.current === probeId) {
        dispatch({ type: 'PROBE_SETTLED' })
      }
    }
  }

  // Auto-detect the server's auth requirement 700ms after the user stops editing a
  // valid URL — a debounced network probe (timer cleared on each keystroke). Gated
  // on the same `validateMcpServerUrl` policy the page uses for Test Connection /
  // Add, so a URL the UI already rejects (e.g. a public http:// host) never probes.
  // The credential and transport are in the deps so a value entered during the
  // window reschedules the probe with the latest inputs instead of firing a stale
  // snapshot (a pasted token would otherwise be ignored and the server
  // misclassified). `lastAutoTestedUrlRef` still keeps a URL that already probed
  // from re-probing, so a credential change after a result lands needs the manual
  // "Test Connection".
  useEffect(() => {
    // Skip the probe for an OAuth-authorized server as long as the token field is
    // empty (its normal Edit-open state — OAuth tokens aren't surfaced). An
    // unauthenticated probe against the OAuth endpoint would 401 and render a
    // misleading "needs authorization" panel over an already-connected server;
    // wait until the user actually types a bearer to convert away from OAuth.
    const skipForOAuthEdit = state.originalConnection?.credentialType === 'oauth' && !state.token
    if (
      !state.isAddFormOpen ||
      !validateMcpServerUrl(state.url).ok ||
      state.url === lastAutoTestedUrlRef.current ||
      skipForOAuthEdit
    ) {
      return
    }
    const timer = setTimeout(() => {
      if (state.url !== lastAutoTestedUrlRef.current) {
        testConnection()
      }
    }, 700)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.url, state.token, state.transport, state.isAddFormOpen])

  // An iroh NodeId/ticket isn't a URL — route it to the peer-to-peer transport
  // and skip the http/sse probe + credential flow (the bridge is allowlist-gated,
  // verified on first use). When set, this overrides the http/sse Select.
  const isIroh = isIrohTarget(state.url.trim())
  const transport: MCPTransportType = isIroh ? 'iroh' : state.transport

  // Name prefixes the server's tools in the prompt. Use the user's name when
  // set, otherwise fall back to the value derived from the URL.
  const resolveServerName = () => state.name.trim() || generateServerName(state.url)

  // Leaving the URL field probes immediately (unless the debounce already did),
  // subject to the same `validateMcpServerUrl` policy as the debounce and the page.
  const handleUrlBlur = () => {
    if (validateMcpServerUrl(state.url).ok && state.url !== lastAutoTestedUrlRef.current) {
      testConnection()
    }
  }

  const changeName = (value: string) => {
    // Name doesn't participate in the probe (only url/transport/token do), so a
    // rename must not invalidate a passing test — otherwise Save Changes gets
    // stuck disabled until the user re-edits a connection field or retests.
    dispatch({ type: 'NAME_CHANGED', value })
  }

  const changeUrl = (value: string) => {
    resetConnectionTest()
    dispatch({ type: 'URL_CHANGED', value, derivedName: state.nameManuallyEdited ? null : generateServerName(value) })
  }

  const changeTransport = (value: MCPTransportType) => {
    resetConnectionTest()
    dispatch({ type: 'TRANSPORT_CHANGED', value })
  }

  const changeToken = (value: string) => {
    resetConnectionTest()
    dispatch({ type: 'TOKEN_CHANGED', value })
  }

  const toggleClearStoredToken = () => {
    resetConnectionTest()
    dispatch({ type: 'CLEAR_STORED_TOKEN_TOGGLED' })
  }

  return {
    isAddFormOpen: state.isAddFormOpen,
    editingServerId: state.editingServerId,
    openAddForm,
    openEditForm,
    resetAddForm,
    name: state.name,
    url: state.url,
    transport,
    isIroh,
    token: state.token,
    hasStoredBearerToken: state.storedBearerToken !== null,
    isClearingStoredToken: state.isClearingStoredToken,
    toggleClearStoredToken,
    changeName,
    changeUrl,
    changeTransport,
    changeToken,
    testResult: state.testResult,
    isTestingConnection: state.isTestingConnection,
    // Derived: the discovered tools live on a successful result — no separate state to keep in sync.
    serverCapabilities: state.testResult.kind === 'success' ? state.testResult.tools : [],
    hasConnectionEdits:
      !state.originalConnection ||
      state.url !== state.originalConnection.url ||
      state.transport !== state.originalConnection.transport ||
      state.token !== '' ||
      state.isClearingStoredToken,
    // No `token === ''` conjunct: the reducer guarantees it — toggling clear
    // empties the token, and typing a token drops the clear flag.
    isClearingBearerOnly:
      !!state.originalConnection &&
      state.originalConnection.credentialType === 'bearer' &&
      state.isClearingStoredToken &&
      state.url === state.originalConnection.url &&
      state.transport === state.originalConnection.transport,
    isOAuthEdit: state.originalConnection?.credentialType === 'oauth' && state.token === '',
    testConnection,
    handleUrlBlur,
    resolveServerName,
  }
}
