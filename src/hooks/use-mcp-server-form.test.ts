import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { useMcpServerFormState } from './use-mcp-server-form'

describe('useMcpServerFormState', () => {
  describe('initial state', () => {
    it('starts with http transport', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      expect(result.current.state.transportType).toBe('http')
    })

    it('starts with empty url and command', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      expect(result.current.state.url).toBe('')
      expect(result.current.state.command).toBe('')
    })

    it('starts with no auth', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      expect(result.current.state.authType).toBe('none')
      expect(result.current.state.bearerToken).toBe('')
    })

    it('starts with idle connection status', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      expect(result.current.state.connectionStatus).toBe('idle')
      expect(result.current.state.connectionError).toBeNull()
    })

    it('starts with empty capabilities and args', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      expect(result.current.state.serverCapabilities).toEqual([])
      expect(result.current.state.args).toEqual([])
    })
  })

  describe('SET_TRANSPORT_TYPE', () => {
    it('changes transport type', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_TRANSPORT_TYPE', payload: 'stdio' })
      })
      expect(result.current.state.transportType).toBe('stdio')
    })

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

  describe('SET_URL', () => {
    it('sets the url', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_URL', payload: 'http://localhost:8000/mcp/' })
      })
      expect(result.current.state.url).toBe('http://localhost:8000/mcp/')
    })
  })

  describe('SET_COMMAND', () => {
    it('sets the command', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_COMMAND', payload: 'npx' })
      })
      expect(result.current.state.command).toBe('npx')
    })
  })

  describe('SET_ARGS', () => {
    it('sets the args array', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_ARGS', payload: ['mcp-server', '--port', '8080'] })
      })
      expect(result.current.state.args).toEqual(['mcp-server', '--port', '8080'])
    })
  })

  describe('SET_AUTH_TYPE', () => {
    it('sets the auth type', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_AUTH_TYPE', payload: 'bearer' })
      })
      expect(result.current.state.authType).toBe('bearer')
    })

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

  describe('SET_BEARER_TOKEN', () => {
    it('sets the bearer token', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_BEARER_TOKEN', payload: 'my-api-key' })
      })
      expect(result.current.state.bearerToken).toBe('my-api-key')
    })
  })

  describe('SET_CONNECTION_STATUS', () => {
    it('updates connection status to testing', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'testing' })
      })
      expect(result.current.state.connectionStatus).toBe('testing')
    })

    it('updates connection status to success', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'success' })
      })
      expect(result.current.state.connectionStatus).toBe('success')
    })

    it('updates connection status to error', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'error' })
      })
      expect(result.current.state.connectionStatus).toBe('error')
    })
  })

  describe('SET_CONNECTION_ERROR', () => {
    it('sets the connection error message', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_CONNECTION_ERROR', payload: 'Connection refused' })
      })
      expect(result.current.state.connectionError).toBe('Connection refused')
    })

    it('clears the connection error', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_CONNECTION_ERROR', payload: 'some error' })
        result.current.dispatch({ type: 'SET_CONNECTION_ERROR', payload: null })
      })
      expect(result.current.state.connectionError).toBeNull()
    })
  })

  describe('SET_CAPABILITIES', () => {
    it('sets server capabilities', () => {
      const { result } = renderHook(() => useMcpServerFormState())
      act(() => {
        result.current.dispatch({ type: 'SET_CAPABILITIES', payload: ['tool_a', 'tool_b'] })
      })
      expect(result.current.state.serverCapabilities).toEqual(['tool_a', 'tool_b'])
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
