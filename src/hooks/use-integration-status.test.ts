/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'bun:test'
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { saveIntegrationCredentials } from '@/dal'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { useIntegrationStatus } from './use-integration-status'
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
    it('should return both providers as not connected when no credentials exist', async () => {
      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isLoading).toBe(false)
      expect(result.current.data).toEqual({
        googleConnected: false,
        googleEnabled: false,
        googleEmail: null,
        microsoftConnected: false,
        microsoftEnabled: false,
        microsoftEmail: null,
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
      await saveIntegrationCredentials(getDb(), 'google', { access_token: 'test_token' }, true)

      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isLoading).toBe(false)
      expect(result.current.data).toEqual({
        googleConnected: true,
        googleEnabled: true,
        googleEmail: null,
        microsoftConnected: false,
        microsoftEnabled: false,
        microsoftEmail: null,
        availableProviders: {
          google: true,
          microsoft: false,
        },
      })
    })
  })

  describe('Microsoft provider connected', () => {
    it('should return Microsoft as connected when credentials exist', async () => {
      await saveIntegrationCredentials(getDb(), 'microsoft', { access_token: 'test_token' }, true)

      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isLoading).toBe(false)
      expect(result.current.data).toEqual({
        googleConnected: false,
        googleEnabled: false,
        googleEmail: null,
        microsoftConnected: true,
        microsoftEnabled: true,
        microsoftEmail: null,
        availableProviders: {
          google: false,
          microsoft: true,
        },
      })
    })
  })

  describe('Both providers connected', () => {
    it('should return both providers as connected when both credentials exist', async () => {
      await saveIntegrationCredentials(getDb(), 'google', { access_token: 'google_token' }, true)
      await saveIntegrationCredentials(getDb(), 'microsoft', { access_token: 'microsoft_token' }, true)

      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isLoading).toBe(false)
      expect(result.current.data).toEqual({
        googleConnected: true,
        googleEnabled: true,
        googleEmail: null,
        microsoftConnected: true,
        microsoftEnabled: true,
        microsoftEmail: null,
        availableProviders: {
          google: true,
          microsoft: true,
        },
      })
    })
  })

  describe('Email surfacing', () => {
    it('should surface profile.email from stored credentials', async () => {
      await saveIntegrationCredentials(
        getDb(),
        'google',
        { access_token: 'g', profile: { email: 'user@example.com', name: 'User' } },
        true,
      )
      await saveIntegrationCredentials(
        getDb(),
        'microsoft',
        { access_token: 'm', profile: { email: 'user@outlook.com', name: 'User' } },
        true,
      )

      const { result } = renderHook(() => useIntegrationStatus(), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.data?.googleEmail).toBe('user@example.com')
      expect(result.current.data?.microsoftEmail).toBe('user@outlook.com')
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
