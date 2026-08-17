/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HttpClientProvider } from '@/contexts/http-client-context'
import { RotationStaleError } from '@/services/encryption'
import { createMockHttpClient } from '@/test-utils/http-client'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { reducer, initialState, useChangeRecoveryKey } from './use-change-recovery-key'

const newPhrase = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima'

const wrapper = ({ children }: { children: ReactNode }) => (
  <HttpClientProvider httpClient={createMockHttpClient()}>{children}</HttpClientProvider>
)

describe('useChangeRecoveryKey reducer', () => {
  it('opens the confirm dialog from idle', () => {
    expect(reducer(initialState, { type: 'OPEN_CONFIRM' }).status).toBe('confirming')
  })

  it('shows the new phrase on success', () => {
    const next = reducer(initialState, { type: 'ROTATION_SUCCESS', payload: newPhrase })
    expect(next.status).toBe('display')
    expect(next.newRecoveryKey).toBe(newPhrase)
    expect(next.isRotating).toBe(false)
  })

  it('stays on the confirm dialog on failure so it doubles as retry', () => {
    const rotating = { ...initialState, status: 'confirming' as const, isRotating: true }
    const next = reducer(rotating, { type: 'ROTATION_FAILED', payload: 'boom' })
    expect(next.status).toBe('confirming')
    expect(next.error).toBe('boom')
    expect(next.isRotating).toBe(false)
  })
})

describe('useChangeRecoveryKey', () => {
  afterEach(cleanup)

  it('rotates and displays the new phrase', async () => {
    const rotate = () => Promise.resolve(newPhrase)
    const { result } = renderHook(() => useChangeRecoveryKey(rotate), { wrapper })

    act(() => result.current.openConfirm())
    expect(result.current.status).toBe('confirming')

    await act(async () => {
      await result.current.confirmRotation()
    })

    expect(result.current.status).toBe('display')
    expect(result.current.newRecoveryKey).toBe(newPhrase)
  })

  it('surfaces a retryable message on RotationStaleError', async () => {
    const rotate = () => Promise.reject(new RotationStaleError())
    const { result } = renderHook(() => useChangeRecoveryKey(rotate), { wrapper })

    act(() => result.current.openConfirm())
    await act(async () => {
      await result.current.confirmRotation()
    })

    expect(result.current.error).toContain('try again')
    expect(result.current.status).toBe('confirming')
  })
})
