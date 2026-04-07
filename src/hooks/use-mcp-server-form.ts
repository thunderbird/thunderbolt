import { useCallback, useReducer } from 'react'
import type { McpServerFormAction, McpServerFormState, McpTransportType } from '@/types/mcp'
import { validateMcpServerUrl, validateStdioArgs, validateStdioCommand } from '@/lib/mcp-utils'

/** Generic command runners whose name isn't meaningful — use the first arg instead */
const genericRunners = new Set(['npx', 'uvx', 'bunx', 'node', 'python', 'python3', 'bun', 'deno'])

/**
 * Generates a short, meaningful server name from transport parameters.
 * - Remote: second-to-last domain segment (render, githubcopilot, notion)
 * - Localhost: includes port for disambiguation (localhost-3000)
 * - stdio: command name, or first arg if command is a generic runner
 */
export const generateServerName = (
  transportType: McpTransportType,
  url: string,
  command: string,
  args: string[],
): string => {
  if (transportType === 'stdio') {
    if (genericRunners.has(command) && args.length > 0) {
      // Use the first meaningful arg: "npx mcp-server" → "mcp-server"
      const firstArg = args[0].replace(/^@[^/]+\//, '') // strip npm scope: @org/pkg → pkg
      return firstArg || command
    }
    return command || ''
  }

  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname
    const port = parsed.port

    // Localhost: include port for disambiguation
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return port ? `localhost-${port}` : 'localhost'
    }

    // Remote: extract meaningful domain segment
    const parts = hostname.split('.')
    // 3+ segments (api.github.com) → second-to-last
    // 2 segments (render.com) → first
    // 1 segment → as-is
    const meaningful = parts.length >= 3 ? parts[parts.length - 2] : parts[0]
    return meaningful
  } catch {
    return ''
  }
}

const initialFormState: McpServerFormState = {
  name: '',
  nameManuallyEdited: false,
  transportType: 'http',
  url: '',
  command: '',
  args: [],
  authType: 'none',
  bearerToken: '',
  connectionStatus: 'idle',
  connectionError: null,
  serverCapabilities: [],
}

const formReducer = (state: McpServerFormState, action: McpServerFormAction): McpServerFormState => {
  switch (action.type) {
    case 'SET_NAME':
      return { ...state, name: action.payload, nameManuallyEdited: true }
    case 'SET_TRANSPORT_TYPE': {
      const newState = {
        ...state,
        transportType: action.payload,
        url: '',
        command: '',
        args: [],
        connectionStatus: 'idle' as const,
        connectionError: null,
        serverCapabilities: [],
        nameManuallyEdited: false,
        name: '',
      }
      return newState
    }
    case 'SET_URL': {
      const base = {
        ...state,
        url: action.payload,
        connectionStatus: 'idle' as const,
        connectionError: null,
        serverCapabilities: [],
      }
      if (state.nameManuallyEdited) {
        return base
      }
      return { ...base, name: generateServerName(state.transportType, action.payload, state.command, state.args) }
    }
    case 'SET_COMMAND': {
      const base = {
        ...state,
        command: action.payload,
        connectionStatus: 'idle' as const,
        connectionError: null,
        serverCapabilities: [],
      }
      if (state.nameManuallyEdited) {
        return base
      }
      return { ...base, name: generateServerName(state.transportType, state.url, action.payload, state.args) }
    }
    case 'SET_ARGS': {
      const base = {
        ...state,
        args: action.payload,
        connectionStatus: 'idle' as const,
        connectionError: null,
        serverCapabilities: [],
      }
      if (state.nameManuallyEdited) {
        return base
      }
      return { ...base, name: generateServerName(state.transportType, state.url, state.command, action.payload) }
    }
    case 'SET_AUTH_TYPE':
      return {
        ...state,
        authType: action.payload,
        bearerToken: '',
        connectionStatus: 'idle',
        connectionError: null,
        serverCapabilities: [],
      }
    case 'SET_BEARER_TOKEN':
      return { ...state, bearerToken: action.payload }
    case 'SET_CONNECTION_STATUS':
      return { ...state, connectionStatus: action.payload }
    case 'SET_CONNECTION_ERROR':
      return { ...state, connectionError: action.payload }
    case 'SET_CAPABILITIES':
      return { ...state, serverCapabilities: action.payload }
    case 'RESET':
      return initialFormState
    default:
      return state
  }
}

export const useMcpServerFormState = () => {
  const [state, dispatch] = useReducer(formReducer, initialFormState)

  const urlValidation = useCallback(() => {
    if (state.transportType === 'stdio') {
      return { valid: true }
    }
    return validateMcpServerUrl(state.url)
  }, [state.transportType, state.url])

  const isValid = useCallback(() => {
    try {
      if (state.transportType === 'stdio') {
        validateStdioCommand(state.command)
        validateStdioArgs(state.args)
        return true
      }
      const validation = validateMcpServerUrl(state.url)
      return validation.valid
    } catch {
      return false
    }
  }, [state.transportType, state.command, state.args, state.url])

  return { state, dispatch, isValid, urlValidation }
}
