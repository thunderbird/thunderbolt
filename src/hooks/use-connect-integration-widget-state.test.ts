import { renderHook, act } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import {
  useConnectIntegrationWidgetState,
  type ConnectIntegrationWidgetState,
  type ConnectIntegrationWidgetAction,
} from './use-connect-integration-widget-state'

/**
 * Creates the expected initial state for the widget state hook
 */
const createExpectedInitialState = (
  selectedProvider: 'google' | 'microsoft' | null,
): ConnectIntegrationWidgetState => ({
  isConnecting: false,
  isDismissed: false,
  isConnected: false,
  connectedProvider: null,
  showConnectedState: false,
  selectedProvider,
})

describe('useConnectIntegrationWidgetState', () => {
  describe('Initial state', () => {
    it('should initialize with empty provider (null selectedProvider)', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      expect(result.current[0]).toEqual(createExpectedInitialState(null))
    })

    it('should initialize with google provider', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState('google'))

      expect(result.current[0]).toEqual(createExpectedInitialState('google'))
    })

    it('should initialize with microsoft provider', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState('microsoft'))

      expect(result.current[0]).toEqual(createExpectedInitialState('microsoft'))
    })
  })

  describe('SET_CONNECTING action', () => {
    it('should preserve other state when setting isConnecting', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState('google'))

      act(() => {
        result.current[1]({ type: 'SET_DISMISSED', payload: true })
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
      })

      expect(result.current[0].isConnecting).toBe(true)
      expect(result.current[0].isDismissed).toBe(true)
      expect(result.current[0].selectedProvider).toBe('google')
    })
  })

  describe('CONNECT_SUCCESS action', () => {
    it('should set connected state correctly for google and microsoft', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'google' })
      })

      expect(result.current[0].isConnecting).toBe(false)
      expect(result.current[0].isConnected).toBe(true)
      expect(result.current[0].connectedProvider).toBe('google')
      expect(result.current[0].showConnectedState).toBe(true)

      act(() => {
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'microsoft' })
      })

      expect(result.current[0].isConnecting).toBe(false)
      expect(result.current[0].isConnected).toBe(true)
      expect(result.current[0].connectedProvider).toBe('microsoft')
      expect(result.current[0].showConnectedState).toBe(true)
    })

    it('should reset isConnecting even if it was true', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'google' })
      })

      expect(result.current[0].isConnecting).toBe(false)
      expect(result.current[0].isConnected).toBe(true)
    })

    it('should preserve selectedProvider', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState('microsoft'))

      act(() => {
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'google' })
      })

      expect(result.current[0].selectedProvider).toBe('microsoft')
      expect(result.current[0].connectedProvider).toBe('google')
    })
  })

  describe('CONNECT_FAILED action', () => {
    it('should reset connecting state and set connectedProvider to null or failed provider', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_FAILED', payload: null })
      })

      expect(result.current[0].isConnecting).toBe(false)
      expect(result.current[0].isConnected).toBe(false)
      expect(result.current[0].connectedProvider).toBe(null)

      act(() => {
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_FAILED', payload: 'google' })
      })

      expect(result.current[0].isConnecting).toBe(false)
      expect(result.current[0].isConnected).toBe(false)
      expect(result.current[0].connectedProvider).toBe('google')
    })

    it('should reset isConnected even if it was true', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'google' })
        result.current[1]({ type: 'CONNECT_FAILED', payload: null })
      })

      expect(result.current[0].isConnected).toBe(false)
      expect(result.current[0].isConnecting).toBe(false)
    })
  })

  describe('State transitions and edge cases', () => {
    it('should handle complete connection flow', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'SET_SELECTED_PROVIDER', payload: 'google' })
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'google' })
      })

      expect(result.current[0].selectedProvider).toBe('google')
      expect(result.current[0].isConnecting).toBe(false)
      expect(result.current[0].isConnected).toBe(true)
      expect(result.current[0].connectedProvider).toBe('google')
      expect(result.current[0].showConnectedState).toBe(true)
    })

    it('should handle connection failure flow', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'SET_SELECTED_PROVIDER', payload: 'microsoft' })
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_FAILED', payload: null })
      })

      expect(result.current[0].selectedProvider).toBe('microsoft')
      expect(result.current[0].isConnecting).toBe(false)
      expect(result.current[0].isConnected).toBe(false)
      expect(result.current[0].connectedProvider).toBe(null)
    })

    it('should handle dismissing after selecting provider', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'SET_SELECTED_PROVIDER', payload: 'google' })
        result.current[1]({ type: 'SET_DISMISSED', payload: true })
      })

      expect(result.current[0].selectedProvider).toBe('google')
      expect(result.current[0].isDismissed).toBe(true)
    })

    it('should handle hiding connected state after success', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'google' })
        result.current[1]({ type: 'SET_SHOW_CONNECTED_STATE', payload: false })
      })

      expect(result.current[0].isConnected).toBe(true)
      expect(result.current[0].connectedProvider).toBe('google')
      expect(result.current[0].showConnectedState).toBe(false)
    })

    it('should handle switching providers after initial selection', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState('google'))

      act(() => {
        result.current[1]({ type: 'SET_SELECTED_PROVIDER', payload: 'microsoft' })
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'microsoft' })
      })

      expect(result.current[0].selectedProvider).toBe('microsoft')
      expect(result.current[0].connectedProvider).toBe('microsoft')
    })

    it('should handle connecting after a previous failure', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'SET_SELECTED_PROVIDER', payload: 'google' })
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_FAILED', payload: null })
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'google' })
      })

      expect(result.current[0].isConnecting).toBe(false)
      expect(result.current[0].isConnected).toBe(true)
      expect(result.current[0].connectedProvider).toBe('google')
    })

    it('should handle connecting with different provider than selected', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState('google'))

      act(() => {
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'microsoft' })
      })

      expect(result.current[0].selectedProvider).toBe('google')
      expect(result.current[0].connectedProvider).toBe('microsoft')
    })
  })

  describe('Default case handling', () => {
    it('should return unchanged state for unknown action type', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState('google'))

      const initialState = result.current[0]

      act(() => {
        result.current[1]({ type: 'UNKNOWN_ACTION', payload: null } as unknown as ConnectIntegrationWidgetAction)
      })

      expect(result.current[0]).toEqual(initialState)
    })
  })
})
