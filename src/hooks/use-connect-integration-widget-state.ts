import { type OAuthProvider } from '@/lib/auth'
import { type Dispatch, useReducer } from 'react'

export type OAuthProviderOrEmpty = OAuthProvider | ''

export type ConnectIntegrationWidgetState = {
  isConnecting: boolean
  isDismissed: boolean
  isConnected: boolean
  connectedProvider: OAuthProvider | null
  showConnectedState: boolean
  availableProviders: {
    google: boolean
    microsoft: boolean
  } | null
  selectedProvider: OAuthProvider | null
}

export type ConnectIntegrationWidgetAction =
  | { type: 'SET_CONNECTING'; payload: boolean }
  | { type: 'SET_DISMISSED'; payload: boolean }
  | { type: 'SET_CONNECTED'; payload: boolean }
  | { type: 'SET_CONNECTED_PROVIDER'; payload: OAuthProvider | null }
  | { type: 'SET_SHOW_CONNECTED_STATE'; payload: boolean }
  | { type: 'SET_AVAILABLE_PROVIDERS'; payload: { google: boolean; microsoft: boolean } | null }
  | { type: 'SET_SELECTED_PROVIDER'; payload: OAuthProvider | null }
  | { type: 'CONNECT_SUCCESS'; payload: OAuthProvider }
  | { type: 'CONNECT_FAILED'; payload: OAuthProvider | null }
  | { type: 'RESET_CONNECTION' }

const connectIntegrationWidgetReducer = (
  state: ConnectIntegrationWidgetState,
  action: ConnectIntegrationWidgetAction,
): ConnectIntegrationWidgetState => {
  switch (action.type) {
    case 'SET_CONNECTING':
      return { ...state, isConnecting: action.payload }
    case 'SET_DISMISSED':
      return { ...state, isDismissed: action.payload }
    case 'SET_CONNECTED':
      return { ...state, isConnected: action.payload }
    case 'SET_CONNECTED_PROVIDER':
      return { ...state, connectedProvider: action.payload }
    case 'SET_SHOW_CONNECTED_STATE':
      return { ...state, showConnectedState: action.payload }
    case 'SET_AVAILABLE_PROVIDERS':
      return { ...state, availableProviders: action.payload }
    case 'SET_SELECTED_PROVIDER':
      return { ...state, selectedProvider: action.payload }
    case 'CONNECT_SUCCESS':
      return {
        ...state,
        isConnecting: false,
        isConnected: true,
        connectedProvider: action.payload,
        showConnectedState: true,
      }
    case 'CONNECT_FAILED':
      return {
        ...state,
        isConnecting: false,
        isConnected: false,
        connectedProvider: action.payload,
      }
    case 'RESET_CONNECTION':
      return {
        ...state,
        isConnected: false,
        connectedProvider: null,
      }
    default:
      return state
  }
}

const createInitialState = (initialProvider: OAuthProviderOrEmpty): ConnectIntegrationWidgetState => ({
  isConnecting: false,
  isDismissed: false,
  isConnected: false,
  connectedProvider: null,
  showConnectedState: false,
  availableProviders: null,
  selectedProvider: initialProvider === '' ? null : initialProvider,
})

export const useConnectIntegrationWidgetState = (
  initialProvider: OAuthProviderOrEmpty,
): [ConnectIntegrationWidgetState, Dispatch<ConnectIntegrationWidgetAction>] => {
  return useReducer(connectIntegrationWidgetReducer, createInitialState(initialProvider))
}
