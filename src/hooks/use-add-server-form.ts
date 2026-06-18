/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { decideTestConnectionResult, type TestConnectionResult } from '@/lib/mcp-auth/auth-decision'
import type { classifyMcpServerAuth } from '@/lib/mcp-auth/web-oauth-flow'
import { isUnauthorizedError } from '@/lib/mcp-errors'
import type { probeMcpServerTools } from '@/lib/mcp-connection-test'
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
  isAddDialogOpen: boolean
  /** Non-null when the dialog is editing an existing server (id) instead of adding one. */
  editingServerId: string | null
  name: string
  /** True once the user edits the name field, so the URL stops re-deriving it. */
  nameManuallyEdited: boolean
  url: string
  transport: MCPTransportType
  token: string
  isTestingConnection: boolean
  testResult: TestConnectionResult | { kind: 'idle' }
  /** Snapshot of url/transport/token at edit-open. Used to detect whether the
   *  user changed a connection-affecting field, so the Save gate can skip the
   *  fresh-probe requirement on a metadata-only edit (e.g. rename) where the
   *  existing credential — including OAuth — is presumed valid. Null in Add mode. */
  originalConnection: { url: string; transport: MCPTransportType; token: string } | null
}

type AddServerFormAction =
  | { type: 'open-dialog' }
  | { type: 'open-edit-dialog'; server: McpServer; bearerToken: string | null }
  | { type: 'reset' }
  | { type: 'set-name'; value: string }
  | { type: 'set-url'; value: string; derivedName: string | null }
  | { type: 'set-transport'; value: MCPTransportType }
  | { type: 'set-token'; value: string }
  | { type: 'reset-test' }
  | { type: 'probe-start' }
  | { type: 'probe-result'; result: TestConnectionResult }
  | { type: 'probe-settled' }

const initialState: AddServerFormState = {
  isAddDialogOpen: false,
  editingServerId: null,
  name: '',
  nameManuallyEdited: false,
  url: '',
  transport: 'http',
  token: '',
  isTestingConnection: false,
  testResult: { kind: 'idle' },
  originalConnection: null,
}

const addServerFormReducer = (state: AddServerFormState, action: AddServerFormAction): AddServerFormState => {
  switch (action.type) {
    case 'open-dialog':
      return { ...state, isAddDialogOpen: true }
    case 'open-edit-dialog': {
      // Edit prefills every field from the existing row. `nameManuallyEdited`
      // is set so a URL change during edit doesn't clobber the existing name.
      const url = action.server.url ?? ''
      const transport: MCPTransportType = action.server.type === 'sse' ? 'sse' : 'http'
      const token = action.bearerToken ?? ''
      return {
        ...initialState,
        isAddDialogOpen: true,
        editingServerId: action.server.id,
        name: action.server.name ?? '',
        nameManuallyEdited: true,
        url,
        transport,
        token,
        originalConnection: { url, transport, token },
      }
    }
    case 'reset':
      return initialState
    case 'set-name':
      return { ...state, name: action.value, nameManuallyEdited: true }
    case 'set-url':
      // The URL re-derives the name only while the user hasn't edited it manually.
      return { ...state, url: action.value, name: action.derivedName ?? state.name }
    case 'set-transport':
      return { ...state, transport: action.value }
    case 'set-token':
      return { ...state, token: action.value }
    case 'reset-test':
      // Invalidating a test clears both the result and any in-flight flag: a probe
      // is invalidated by bumping `probeIdRef`, which makes its `finally` skip the
      // `probe-settled` dispatch, so the flag must be cleared here or the spinner
      // (and the disabled "Test Connection" button) would stay stuck forever.
      return { ...state, isTestingConnection: false, testResult: { kind: 'idle' } }
    case 'probe-start':
      return { ...state, isTestingConnection: true, testResult: { kind: 'idle' } }
    case 'probe-result':
      return { ...state, testResult: action.result }
    case 'probe-settled':
      return { ...state, isTestingConnection: false }
    default:
      return state
  }
}

/** Test-only DI seams for the Add-dialog probe + OAuth-discovery classification,
 *  plus the proxy-routed fetch builder they share with the live transport. */
export type AddServerFormDeps = {
  probeMcpServerTools: typeof probeMcpServerTools
  classifyMcpServerAuth: typeof classifyMcpServerAuth
  buildOAuthFetch: () => FetchFn
}

export type UseAddServerFormResult = {
  isAddDialogOpen: boolean
  /** Id of the server being edited, or null when the dialog is in Add mode. */
  editingServerId: string | null
  openDialog: () => void
  /** Opens the dialog in Edit mode with all fields prefilled from the existing server. */
  openEditDialog: (server: McpServer, bearerToken: string | null) => void
  /** Closes the dialog and clears all add-form state (Cancel / Escape / overlay). */
  resetAddDialog: () => void
  name: string
  url: string
  transport: MCPTransportType
  token: string
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
  testConnection: () => Promise<void>
  /** Leaving the URL field probes immediately (unless the debounce already did). */
  handleUrlBlur: () => void
  /** Name prefixes the server's tools in the prompt — user value or URL-derived fallback. */
  resolveServerName: () => string
}

/**
 * Owns the "Add MCP Server" dialog form: the field state (name/url/transport/
 * token), the Test Connection probe with its auth classification, and the
 * stale-probe / dialog-reset bookkeeping. Mirrors `useMcpServerOAuth`'s
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

  const openDialog = () => dispatch({ type: 'open-dialog' })

  // Open the dialog with every field prefilled from an existing server row +
  // its on-device bearer token (null for OAuth or no-cred). The auto-detect
  // effect will probe the prefilled URL after the standard 700ms debounce, so
  // the user must still pass Test Connection before saving — same gate as Add.
  const openEditDialog = (server: McpServer, bearerToken: string | null) => {
    probeIdRef.current += 1
    lastAutoTestedUrlRef.current = null
    onClearDialogError()
    dispatch({ type: 'open-edit-dialog', server, bearerToken })
  }

  // Closes the Add dialog and clears all add-form state. Bumps the probe id so an
  // in-flight connection probe can't land its result after the dialog is gone.
  const resetAddDialog = () => {
    probeIdRef.current += 1
    dispatch({ type: 'reset' })
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
    dispatch({ type: 'reset-test' })
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

    dispatch({ type: 'probe-start' })

    try {
      // Build the transport the same way the provider does — through the
      // universal proxy so the test matches the real connection path (web CORS
      // would otherwise fail for remote servers).
      const headers = buildMcpHeaders(state.token || undefined)
      const transport = createMcpTransport(state.url, state.transport, cloudUrl, headers)

      const toolNames = await deps.probeMcpServerTools(transport)
      if (probeIdRef.current !== probeId) {
        return
      }
      dispatch({ type: 'probe-result', result: { kind: 'success', tools: toolNames } })
    } catch (error) {
      // A 401 here is the OAuth/credential probe signal, not a failure — keep it at warn.
      console.warn('Connection test error:', error)
      // Auth precedence: a supplied credential that 401s is a rejected token (no
      // Authorize). An empty-credential 401 classifies the server: 'authorizable'
      // (DCR/CIMD → Add & Authorize), 'token-only' (OAuth advertised but no usable
      // registration, e.g. GitHub → ask for a static token), or 'none'.
      const oauthActionability =
        !state.token && isUnauthorizedError(error)
          ? await deps.classifyMcpServerAuth(state.url, deps.buildOAuthFetch())
          : 'none'
      if (probeIdRef.current !== probeId) {
        return
      }
      dispatch({
        type: 'probe-result',
        result: decideTestConnectionResult({ hasCredential: !!state.token, error, oauthActionability }),
      })
    } finally {
      if (probeIdRef.current === probeId) {
        dispatch({ type: 'probe-settled' })
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
    if (!state.isAddDialogOpen || !validateMcpServerUrl(state.url).ok || state.url === lastAutoTestedUrlRef.current) {
      return
    }
    const timer = setTimeout(() => {
      if (state.url !== lastAutoTestedUrlRef.current) {
        testConnection()
      }
    }, 700)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.url, state.token, state.transport, state.isAddDialogOpen])

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
    dispatch({ type: 'set-name', value })
  }

  const changeUrl = (value: string) => {
    resetConnectionTest()
    dispatch({ type: 'set-url', value, derivedName: state.nameManuallyEdited ? null : generateServerName(value) })
  }

  const changeTransport = (value: MCPTransportType) => {
    resetConnectionTest()
    dispatch({ type: 'set-transport', value })
  }

  const changeToken = (value: string) => {
    resetConnectionTest()
    dispatch({ type: 'set-token', value })
  }

  return {
    isAddDialogOpen: state.isAddDialogOpen,
    editingServerId: state.editingServerId,
    openDialog,
    openEditDialog,
    resetAddDialog,
    name: state.name,
    url: state.url,
    transport: state.transport,
    token: state.token,
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
      state.token !== state.originalConnection.token,
    testConnection,
    handleUrlBlur,
    resolveServerName,
  }
}
