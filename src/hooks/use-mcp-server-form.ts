import { useCallback, useReducer } from 'react'
import type { McpServerFormAction, McpServerFormState } from '@/types/mcp'
import { validateMcpUrl, validateStdioArgs, validateStdioCommand } from '@/lib/mcp-utils'

const initialFormState: McpServerFormState = {
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
    case 'SET_TRANSPORT_TYPE':
      return {
        ...state,
        transportType: action.payload,
        url: '',
        command: '',
        args: [],
        connectionStatus: 'idle',
        connectionError: null,
      }
    case 'SET_URL':
      return { ...state, url: action.payload }
    case 'SET_COMMAND':
      return { ...state, command: action.payload }
    case 'SET_ARGS':
      return { ...state, args: action.payload }
    case 'SET_AUTH_TYPE':
      return { ...state, authType: action.payload, bearerToken: '' }
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

  const isValid = useCallback(() => {
    try {
      if (state.transportType === 'stdio') {
        validateStdioCommand(state.command)
        validateStdioArgs(state.args)
        return true
      }
      validateMcpUrl(state.url)
      return true
    } catch {
      return false
    }
  }, [state])

  return { state, dispatch, isValid }
}
