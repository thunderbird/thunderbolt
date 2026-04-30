/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { renderHook, act } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import {
  useConnectIntegrationWidgetState,
  type ConnectIntegrationWidgetState,
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
    it('should initialize with null provider when empty string provided', () => {
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

  describe('User flow: Select provider and connect successfully', () => {
    it('should handle successful connection flow for google', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'SET_SELECTED_PROVIDER', payload: 'google' })
      })
      expect(result.current[0].selectedProvider).toBe('google')

      act(() => {
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
      })
      expect(result.current[0].isConnecting).toBe(true)

      act(() => {
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'google' })
      })
      expect(result.current[0]).toMatchObject({
        isConnecting: false,
        isConnected: true,
        connectedProvider: 'google',
        showConnectedState: true,
      })
    })

    it('should handle successful connection flow for microsoft', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'SET_SELECTED_PROVIDER', payload: 'microsoft' })
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'microsoft' })
      })

      expect(result.current[0]).toMatchObject({
        selectedProvider: 'microsoft',
        isConnecting: false,
        isConnected: true,
        connectedProvider: 'microsoft',
        showConnectedState: true,
      })
    })
  })

  describe('User flow: Connect and fail', () => {
    it('should handle connection failure and reset state', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'SET_SELECTED_PROVIDER', payload: 'google' })
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_FAILED', payload: null })
      })

      expect(result.current[0]).toMatchObject({
        selectedProvider: 'google',
        isConnecting: false,
        isConnected: false,
        connectedProvider: null,
      })
    })

    it('should allow retry after failure', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'SET_SELECTED_PROVIDER', payload: 'google' })
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_FAILED', payload: null })
      })

      expect(result.current[0].isConnected).toBe(false)

      act(() => {
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'google' })
      })

      expect(result.current[0].isConnected).toBe(true)
    })
  })

  describe('User flow: Dismiss widget', () => {
    it('should allow user to dismiss widget before connecting', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'SET_SELECTED_PROVIDER', payload: 'google' })
        result.current[1]({ type: 'SET_DISMISSED', payload: true })
      })

      expect(result.current[0].isDismissed).toBe(true)
      expect(result.current[0].selectedProvider).toBe('google')
    })
  })

  describe('User flow: Hide connected state after timeout', () => {
    it('should hide connected state while preserving connection status', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState(''))

      act(() => {
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'google' })
      })

      expect(result.current[0].showConnectedState).toBe(true)

      act(() => {
        result.current[1]({ type: 'SET_SHOW_CONNECTED_STATE', payload: false })
      })

      expect(result.current[0]).toMatchObject({
        isConnected: true,
        connectedProvider: 'google',
        showConnectedState: false,
      })
    })
  })

  describe('Edge case: Provider pre-selected', () => {
    it('should skip provider selection when provider is pre-selected', () => {
      const { result } = renderHook(() => useConnectIntegrationWidgetState('google'))

      expect(result.current[0].selectedProvider).toBe('google')

      act(() => {
        result.current[1]({ type: 'SET_CONNECTING', payload: true })
        result.current[1]({ type: 'CONNECT_SUCCESS', payload: 'google' })
      })

      expect(result.current[0]).toMatchObject({
        selectedProvider: 'google',
        isConnected: true,
        connectedProvider: 'google',
      })
    })
  })
})
