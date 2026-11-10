/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { HttpError } from '@/lib/http'
import { DecryptionError, DeviceApprovalError } from '@/crypto/errors'
import { EncryptionRequestTimeoutError } from '@/services/encryption-request'
import { useApprovalPolling } from './use-approval-polling'

const createHTTPError = (status: number) => new HttpError(new Response(null, { status }))
const createRevokedError = () =>
  new HttpError(new Response(JSON.stringify({ code: 'DEVICE_DISCONNECTED' }), { status: 403 }))

describe('useApprovalPolling', () => {
  afterEach(() => {
    cleanup()
  })

  it('reports receiver-verification failure and can still recover on a later poll', async () => {
    let attempt = 0
    const onVerificationFailed = mock(() => {})
    const onApproved = mock(() => {})
    const checkApproval = async () => {
      attempt += 1
      if (attempt === 1) {
        throw new DeviceApprovalError('recipient-unverified')
      }
      return true
    }
    renderHook(() =>
      useApprovalPolling({ enabled: true, checkApproval, onApproved, onVerificationFailed, intervalMs: 50 }),
    )
    await act(async () => {
      await getClock().tickAsync(60)
    })
    expect(onVerificationFailed).toHaveBeenCalledTimes(1)
    expect(onApproved).not.toHaveBeenCalled()
    await act(async () => {
      await getClock().tickAsync(60)
    })
    expect(onApproved).toHaveBeenCalledTimes(1)
  })

  it('does not poll when disabled', async () => {
    const checkApproval = mock(() => Promise.resolve(false))
    const onApproved = mock(() => {})
    renderHook(() => useApprovalPolling({ enabled: false, checkApproval, onApproved, intervalMs: 50 }))

    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(checkApproval).not.toHaveBeenCalled()
  })

  it('polls and calls onApproved when approved', async () => {
    const checkApproval = mock(() => Promise.resolve(true))
    const onApproved = mock(() => {})

    renderHook(() => useApprovalPolling({ enabled: true, checkApproval, onApproved, intervalMs: 50 }))

    await act(async () => {
      await getClock().tickAsync(60)
    })
    expect(checkApproval).toHaveBeenCalled()
    expect(onApproved).toHaveBeenCalledTimes(1)
  })

  it('continues polling silently on transient errors then succeeds', async () => {
    const transientErrors = [
      new TypeError('Failed to fetch'),
      new EncryptionRequestTimeoutError(),
      createHTTPError(503),
      createHTTPError(429),
    ]
    let callCount = 0
    const checkApproval = mock(() => {
      callCount++
      const error = transientErrors[callCount - 1]
      return error ? Promise.reject(error) : Promise.resolve(true)
    })
    const onApproved = mock(() => {})
    const onError = mock(() => {})

    renderHook(() => useApprovalPolling({ enabled: true, checkApproval, onApproved, onError, intervalMs: 50 }))

    await act(async () => {
      await getClock().tickAsync(300)
    })
    expect(onApproved).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    expect(callCount).toBe(5)
  })

  it('reports a TypeError that is not a network failure', async () => {
    const failure = new TypeError("Cannot read properties of null (reading 'kdf_salt')")
    const checkApproval = mock(() => Promise.reject(failure))
    const onError = mock(() => {})

    renderHook(() =>
      useApprovalPolling({ enabled: true, checkApproval, onApproved: () => {}, onError, intervalMs: 50 }),
    )

    await act(async () => {
      await getClock().tickAsync(60)
    })
    expect(onError).toHaveBeenCalledWith(failure)
  })

  it('reports a failure that keeps happening and keeps polling', async () => {
    const failure = new DecryptionError('Envelope could not be opened')
    let callCount = 0
    const checkApproval = mock(() => {
      callCount++
      return callCount === 1 ? Promise.reject(failure) : Promise.resolve(true)
    })
    const onApproved = mock(() => {})
    const onError = mock(() => {})

    renderHook(() => useApprovalPolling({ enabled: true, checkApproval, onApproved, onError, intervalMs: 50 }))

    await act(async () => {
      await getClock().tickAsync(60)
    })
    expect(onError).toHaveBeenCalledWith(failure)
    expect(onApproved).not.toHaveBeenCalled()
    await act(async () => {
      await getClock().tickAsync(60)
    })
    expect(onApproved).toHaveBeenCalledTimes(1)
  })

  it('stops polling on unmount', async () => {
    const checkApproval = mock(() => Promise.resolve(false))
    const onApproved = mock(() => {})
    const { unmount } = renderHook(() =>
      useApprovalPolling({ enabled: true, checkApproval, onApproved, intervalMs: 50 }),
    )

    unmount()
    const callsBefore = checkApproval.mock.calls.length

    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(checkApproval.mock.calls.length).toBe(callsBefore)
  })

  it('stops polling when enabled changes to false', async () => {
    const checkApproval = mock(() => Promise.resolve(false))
    const onApproved = mock(() => {})
    const { rerender } = renderHook(
      ({ enabled }) => useApprovalPolling({ enabled, checkApproval, onApproved, intervalMs: 50 }),
      { initialProps: { enabled: true } },
    )

    await act(async () => {
      await getClock().tickAsync(60)
    })

    rerender({ enabled: false })

    const callsBefore = checkApproval.mock.calls.length
    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(checkApproval.mock.calls.length).toBe(callsBefore)
  })

  it('ignores a late approval after disabling and polls again when re-enabled', async () => {
    const pendingApproval = Promise.withResolvers<boolean>()
    const checkApproval = mock(() => pendingApproval.promise)
    const onApproved = mock(() => {})
    const { rerender } = renderHook(
      ({ enabled }) => useApprovalPolling({ enabled, checkApproval, onApproved, intervalMs: 50 }),
      { initialProps: { enabled: true } },
    )
    await act(async () => {
      await getClock().tickAsync(60)
    })
    expect(checkApproval).toHaveBeenCalledTimes(1)

    rerender({ enabled: false })
    await act(async () => {
      pendingApproval.resolve(true)
      await getClock().tickAsync(200)
    })
    expect(onApproved).not.toHaveBeenCalled()
    expect(checkApproval).toHaveBeenCalledTimes(1)

    rerender({ enabled: true })
    await act(async () => {
      await getClock().tickAsync(60)
    })
    expect(checkApproval).toHaveBeenCalledTimes(2)
    expect(onApproved).toHaveBeenCalledTimes(1)
  })

  it('calls onRevoked and stops polling on 403 error', async () => {
    const error403 = createRevokedError()
    const checkApproval = mock(() => Promise.reject(error403))
    const onApproved = mock(() => {})
    const onRevoked = mock(() => {})

    renderHook(() => useApprovalPolling({ enabled: true, checkApproval, onApproved, onRevoked, intervalMs: 50 }))

    await act(async () => {
      await getClock().tickAsync(60)
    })

    expect(onRevoked).toHaveBeenCalledTimes(1)
    expect(onApproved).not.toHaveBeenCalled()

    // Verify polling stopped
    const callsBefore = checkApproval.mock.calls.length
    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(checkApproval.mock.calls.length).toBe(callsBefore)
  })

  it('keeps polling on a 403 without DEVICE_DISCONNECTED (session not yet bound)', async () => {
    const checkApproval = mock(() => Promise.reject(createHTTPError(403)))
    const onRevoked = mock(() => {})

    renderHook(() =>
      useApprovalPolling({ enabled: true, checkApproval, onApproved: () => {}, onRevoked, intervalMs: 50 }),
    )

    await act(async () => {
      await getClock().tickAsync(200)
    })

    expect(onRevoked).not.toHaveBeenCalled()
    expect(checkApproval.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('continues polling on non-403 errors but stops on 403', async () => {
    let callCount = 0
    const checkApproval = mock(() => {
      callCount++
      if (callCount <= 2) {
        return Promise.reject(new Error('Network error'))
      }
      return Promise.reject(createRevokedError())
    })
    const onApproved = mock(() => {})
    const onRevoked = mock(() => {})

    renderHook(() => useApprovalPolling({ enabled: true, checkApproval, onApproved, onRevoked, intervalMs: 50 }))

    await act(async () => {
      await getClock().tickAsync(200)
    })

    expect(onRevoked).toHaveBeenCalledTimes(1)
    expect(onApproved).not.toHaveBeenCalled()
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  it('does not call onRevoked after cleanup even if 403 arrives', async () => {
    let rejectCheck: (reason: Error) => void
    const checkApproval = mock(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectCheck = reject
        }),
    )
    const onApproved = mock(() => {})
    const onRevoked = mock(() => {})

    const { unmount } = renderHook(() =>
      useApprovalPolling({ enabled: true, checkApproval, onApproved, onRevoked, intervalMs: 50 }),
    )

    await act(async () => {
      await getClock().tickAsync(60)
    })

    unmount()

    await act(async () => {
      rejectCheck!(createRevokedError())
    })

    expect(onRevoked).not.toHaveBeenCalled()
  })

  it('does not call onRevoked when cleanup happens while the 403 body is still being read', async () => {
    // A body that stays open until the test closes it, so cleanup lands mid-read.
    let bodyController: ReadableStreamDefaultController<Uint8Array>
    const slowBody = new ReadableStream<Uint8Array>({
      start: (controller) => {
        bodyController = controller
      },
    })
    const checkApproval = mock(() => Promise.reject(new HttpError(new Response(slowBody, { status: 403 }))))
    const onRevoked = mock(() => {})

    const { unmount } = renderHook(() =>
      useApprovalPolling({ enabled: true, checkApproval, onApproved: () => {}, onRevoked, intervalMs: 50 }),
    )

    await act(async () => {
      await getClock().tickAsync(60)
    })

    unmount()

    await act(async () => {
      bodyController!.enqueue(new TextEncoder().encode(JSON.stringify({ code: 'DEVICE_DISCONNECTED' })))
      bodyController!.close()
    })

    expect(onRevoked).not.toHaveBeenCalled()
  })

  it('does not call onApproved after cleanup even if check resolves', async () => {
    let resolveCheck: (value: boolean) => void
    const checkApproval = mock(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve
        }),
    )
    const onApproved = mock(() => {})

    const { unmount } = renderHook(() =>
      useApprovalPolling({ enabled: true, checkApproval, onApproved, intervalMs: 50 }),
    )

    // Trigger the first check
    await act(async () => {
      await getClock().tickAsync(60)
    })

    // Unmount while check is in-flight
    unmount()

    // Resolve the in-flight check with approved=true
    await act(async () => {
      resolveCheck!(true)
    })

    expect(onApproved).not.toHaveBeenCalled()
  })
})
