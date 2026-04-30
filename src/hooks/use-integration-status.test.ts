/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'bun:test'
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { useIntegrationStatus } from './use-integration-status'
import { updateSettings } from '@/dal/settings'
import { getClock } from '@/testing-library'

describe('useIntegrationStatus', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    await resetTestDatabase()
  })

  describe('Loading state', () => {
    it('should return isLoading true initially', () => {
      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      expect(result.current.isLoading).toBe(true)
      expect(result.current.data).toBeNull()
      expect(result.current.error).toBeNull()
    })
  })

  describe('No providers connected', () => {
    it('should return both providers as not connected when credentials are empty', async () => {
      await updateSettings(getDb(), {
        integrations_google_credentials: '',
        integrations_microsoft_credentials: '',
      })

      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isLoading).toBe(false)

      expect(result.current.data).toEqual({
        googleConnected: false,
        microsoftConnected: false,
        availableProviders: {
          google: false,
          microsoft: false,
        },
      })
      expect(result.current.error).toBeNull()
    })

    it('should return both providers as not connected when credentials are null', async () => {
      await updateSettings(getDb(), {
        integrations_google_credentials: null,
        integrations_microsoft_credentials: null,
      })

      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isLoading).toBe(false)

      expect(result.current.data).toEqual({
        googleConnected: false,
        microsoftConnected: false,
        availableProviders: {
          google: false,
          microsoft: false,
        },
      })
      expect(result.current.error).toBeNull()
    })
  })

  describe('Google provider connected', () => {
    it('should return Google as connected when credentials exist', async () => {
      await updateSettings(getDb(), {
        integrations_google_credentials: JSON.stringify({ access_token: 'test_token' }),
        integrations_microsoft_credentials: '',
      })

      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isLoading).toBe(false)

      expect(result.current.data).toEqual({
        googleConnected: true,
        microsoftConnected: false,
        availableProviders: {
          google: true,
          microsoft: false,
        },
      })
      expect(result.current.error).toBeNull()
    })
  })

  describe('Microsoft provider connected', () => {
    it('should return Microsoft as connected when credentials exist', async () => {
      await updateSettings(getDb(), {
        integrations_google_credentials: '',
        integrations_microsoft_credentials: JSON.stringify({ access_token: 'test_token' }),
      })

      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isLoading).toBe(false)

      expect(result.current.data).toEqual({
        googleConnected: false,
        microsoftConnected: true,
        availableProviders: {
          google: false,
          microsoft: true,
        },
      })
      expect(result.current.error).toBeNull()
    })
  })

  describe('Both providers connected', () => {
    it('should return both providers as connected when both credentials exist', async () => {
      await updateSettings(getDb(), {
        integrations_google_credentials: JSON.stringify({ access_token: 'google_token' }),
        integrations_microsoft_credentials: JSON.stringify({ access_token: 'microsoft_token' }),
      })

      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isLoading).toBe(false)

      expect(result.current.data).toEqual({
        googleConnected: true,
        microsoftConnected: true,
        availableProviders: {
          google: true,
          microsoft: true,
        },
      })
      expect(result.current.error).toBeNull()
    })
  })

  describe('Edge cases', () => {
    it('should treat empty string as not connected', async () => {
      await updateSettings(getDb(), {
        integrations_google_credentials: '',
        integrations_microsoft_credentials: '',
      })

      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isLoading).toBe(false)

      expect(result.current.data?.googleConnected).toBe(false)
      expect(result.current.data?.microsoftConnected).toBe(false)
    })

    it('should correctly identify connection status for different credential states', async () => {
      await updateSettings(getDb(), {
        integrations_google_credentials: '',
        integrations_microsoft_credentials: '',
      })

      const { result: result1 } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result1.current.isLoading).toBe(false)
      expect(result1.current.data?.googleConnected).toBe(false)
      expect(result1.current.data?.microsoftConnected).toBe(false)

      await updateSettings(getDb(), { integrations_google_credentials: JSON.stringify({ access_token: 'new_token' }) })

      const { result: result2 } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result2.current.isLoading).toBe(false)
      expect(result2.current.data?.googleConnected).toBe(true)
      expect(result2.current.data?.microsoftConnected).toBe(false)
    })

    it('should return data structure with correct types', async () => {
      await updateSettings(getDb(), {
        integrations_google_credentials: JSON.stringify({ access_token: 'test_token' }),
        integrations_microsoft_credentials: JSON.stringify({ access_token: 'test_token' }),
      })

      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isLoading).toBe(false)

      expect(result.current.data).toBeDefined()
      expect(typeof result.current.data?.googleConnected).toBe('boolean')
      expect(typeof result.current.data?.microsoftConnected).toBe('boolean')
      expect(typeof result.current.data?.availableProviders.google).toBe('boolean')
      expect(typeof result.current.data?.availableProviders.microsoft).toBe('boolean')
    })
  })

  describe('Query behavior', () => {
    it('should return null data when query is loading', () => {
      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      expect(result.current.data).toBeNull()
      expect(result.current.isLoading).toBe(true)
    })

    it('should handle query completion successfully', async () => {
      await updateSettings(getDb(), {
        integrations_google_credentials: '',
        integrations_microsoft_credentials: '',
      })

      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper({
          defaultOptions: {
            queries: {
              retry: false,
            },
          },
        }),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isLoading).toBe(false)

      expect(result.current.data).toBeDefined()
      expect(result.current.error).toBeNull()
    })
  })
})
