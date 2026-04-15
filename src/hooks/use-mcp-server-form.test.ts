import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { useMcpServerFormState } from './use-mcp-server-form'

describe('useMcpServerFormState', () => {
  describe('SET_TRANSPORT_TYPE', () => {
    it('resets url, command, args and connection state on transport change', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_URL', payload: 'http://example.com' })
        result.current.dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'success' })
        result.current.dispatch({ type: 'SET_CONNECTION_ERROR', payload: 'some error' })
      })
      act(() => {
        result.current.dispatch({ type: 'SET_TRANSPORT_TYPE', payload: 'sse' })
      })
      expect(result.current.state.url).toBe('')
      expect(result.current.state.command).toBe('')
      expect(result.current.state.args).toEqual([])
      expect(result.current.state.connectionStatus).toBe('idle')
      expect(result.current.state.connectionError).toBeNull()
    })
  })

  describe('SET_AUTH_TYPE', () => {
    it('clears bearer token when auth type changes', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_AUTH_TYPE', payload: 'bearer' })
        result.current.dispatch({ type: 'SET_BEARER_TOKEN', payload: 'secret-token' })
      })
      act(() => {
        result.current.dispatch({ type: 'SET_AUTH_TYPE', payload: 'none' })
      })
      expect(result.current.state.bearerToken).toBe('')
    })
  })

  describe('RESET', () => {
    it('resets all state to initial values', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_TRANSPORT_TYPE', payload: 'stdio' })
        result.current.dispatch({ type: 'SET_COMMAND', payload: 'npx' })
        result.current.dispatch({ type: 'SET_AUTH_TYPE', payload: 'bearer' })
        result.current.dispatch({ type: 'SET_BEARER_TOKEN', payload: 'secret' })
        result.current.dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'success' })
      })
      act(() => {
        result.current.dispatch({ type: 'RESET' })
      })
      expect(result.current.state.transportType).toBe('http')
      expect(result.current.state.command).toBe('')
      expect(result.current.state.authType).toBe('none')
      expect(result.current.state.bearerToken).toBe('')
      expect(result.current.state.connectionStatus).toBe('idle')
    })
  })

  describe('isValid', () => {
    it('returns false when http transport has empty url', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      expect(result.current.isValid()).toBe(false)
    })

    it('returns true when http transport has valid url', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_URL', payload: 'http://localhost:8000/mcp/' })
      })
      expect(result.current.isValid()).toBe(true)
    })

    it('returns false when http transport has invalid url', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_URL', payload: 'not-a-url' })
      })
      expect(result.current.isValid()).toBe(false)
    })

    it('returns false when http transport has javascript: url', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_URL', payload: 'javascript:alert(1)' })
      })
      expect(result.current.isValid()).toBe(false)
    })

    it('returns true when sse transport has valid url', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_TRANSPORT_TYPE', payload: 'sse' })
        result.current.dispatch({ type: 'SET_URL', payload: 'https://example.com/sse' })
      })
      expect(result.current.isValid()).toBe(true)
    })

    it('returns false when stdio transport has empty command', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_TRANSPORT_TYPE', payload: 'stdio' })
      })
      expect(result.current.isValid()).toBe(false)
    })

    it('returns true when stdio transport has valid command', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_TRANSPORT_TYPE', payload: 'stdio' })
        result.current.dispatch({ type: 'SET_COMMAND', payload: 'npx' })
      })
      expect(result.current.isValid()).toBe(true)
    })

    it('returns false when stdio transport has invalid command', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_TRANSPORT_TYPE', payload: 'stdio' })
        result.current.dispatch({ type: 'SET_COMMAND', payload: 'npx; rm -rf /' })
      })
      expect(result.current.isValid()).toBe(false)
    })

    it('returns false when stdio args contain null byte', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_TRANSPORT_TYPE', payload: 'stdio' })
        result.current.dispatch({ type: 'SET_COMMAND', payload: 'npx' })
        result.current.dispatch({ type: 'SET_ARGS', payload: ['arg\0'] })
      })
      expect(result.current.isValid()).toBe(false)
    })
  })
})
