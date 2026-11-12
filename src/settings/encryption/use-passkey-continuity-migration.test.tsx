/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HttpClientProvider } from '@/contexts/http-client-context'
import {
  PasskeyContinuityUnsupportedError,
  PasskeyMismatchError,
  UnverifiedAccountKeyError,
} from '@/services/encryption'
import { createMockHttpClient } from '@/test-utils/http-client'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { usePasskeyContinuityMigration } from './use-passkey-continuity-migration'

const wrapper = ({ children }: { children: ReactNode }) => (
  <HttpClientProvider httpClient={createMockHttpClient()}>{children}</HttpClientProvider>
)

const prfOutput = new Uint8Array(32).fill(5)

describe('usePasskeyContinuityMigration', () => {
  afterEach(cleanup)

  // A second tap while the status re-read is still in flight must not start a
  // second passkey prompt, whose cancellation would show as an error.
  it('ignores a second run while the first is in flight, status read included', async () => {
    const lookup = Promise.withResolvers<string | null>()
    const migrate = mock(async (): Promise<'sealed' | 'alreadySealed'> => 'sealed')
    const { result } = renderHook(() => usePasskeyContinuityMigration(migrate, async () => prfOutput), { wrapper })

    let first!: Promise<'sealed' | 'alreadySealed' | null>
    let second!: Promise<'sealed' | 'alreadySealed' | null>
    act(() => {
      first = result.current.run(() => lookup.promise)
      second = result.current.run(async () => 'credential')
    })
    expect(await second).toBeNull()
    await act(async () => {
      lookup.resolve('credential')
      expect(await first).toBe('sealed')
    })
    expect(migrate).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeNull()
  })

  it('reports a failed status read', async () => {
    const migrate = mock(async (): Promise<'sealed' | 'alreadySealed'> => 'sealed')
    const { result } = renderHook(() => usePasskeyContinuityMigration(migrate, async () => prfOutput), { wrapper })

    await act(async () => {
      expect(
        await result.current.run(async () => {
          throw new Error('offline')
        }),
      ).toBeNull()
    })
    expect(result.current.error).toBe('failed')
    expect(migrate).not.toHaveBeenCalled()
  })

  it('cancelled ceremony writes nothing and can be retried', async () => {
    const readPrf = mock(async (): Promise<Uint8Array | null> => {
      throw new DOMException('', 'NotAllowedError')
    })
    const migrate = mock(async () => 'sealed' as const)
    const { result } = renderHook(() => usePasskeyContinuityMigration(migrate, readPrf), { wrapper })

    await act(async () => {
      expect(await result.current.run(async () => 'credential')).toBeNull()
    })
    expect(result.current.error).toBe('cancelled')
    expect(result.current.errorMessage).toBe("The passkey check was cancelled. Try again when you're ready.")
    expect(migrate).not.toHaveBeenCalled()

    readPrf.mockImplementation(async () => prfOutput)
    await act(async () => {
      expect(await result.current.run(async () => 'credential')).toBe('sealed')
    })
    expect(result.current.error).toBeNull()
    expect(migrate).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'mismatch',
      new PasskeyMismatchError(),
      "This passkey doesn't match the one saved for sync. Remove it and add it again.",
    ],
    ['unsupported', new PasskeyContinuityUnsupportedError(), "Passkey updates aren't available yet. Try again later."],
    [
      'unverified',
      new UnverifiedAccountKeyError(),
      "This device can't add or update a passkey because its encryption keys couldn't be verified. Do it from a device that was trusted before.",
    ],
  ] as const)('maps %s', async (error, thrown, message) => {
    const migrate = mock(async (): Promise<'sealed' | 'alreadySealed'> => {
      throw thrown
    })
    const { result } = renderHook(() => usePasskeyContinuityMigration(migrate, async () => prfOutput), { wrapper })

    await act(async () => {
      await result.current.run(async () => 'credential')
    })
    expect(result.current.error).toBe(error)
    expect(result.current.errorMessage).toBe(message)
  })

  it('explains a passkey without PRF support', async () => {
    const migrate = mock(async () => 'sealed' as const)
    const { result } = renderHook(() => usePasskeyContinuityMigration(migrate, async () => null), { wrapper })

    await act(async () => {
      await result.current.run(async () => 'credential')
    })
    expect(result.current.error).toBe('noPrf')
    expect(result.current.errorMessage).toBe(
      "This passkey can't unlock encrypted data. Remove it and add another passkey.",
    )
    expect(migrate).not.toHaveBeenCalled()
  })
})
