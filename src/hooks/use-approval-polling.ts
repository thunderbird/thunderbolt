/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'
import { HttpError, isFetchNetworkError } from '@/lib/http'
import { DeviceApprovalError } from '@/crypto/errors'
import { EncryptionOperationCancelledError } from '@/crypto/key-storage-lifetime'
import { EncryptionRequestTimeoutError } from '@/services/encryption-request'

type UseApprovalPollingOptions = {
  enabled: boolean
  checkApproval: () => Promise<boolean>
  onApproved: () => void
  onRevoked?: () => void
  onDenied?: () => void
  onVerificationFailed?: () => void
  /** A failure the next tick will likely hit again (an envelope that won't open, missing keys). */
  onError?: (error: Error) => void
  intervalMs?: number
}

/** A session not yet bound to this device (403), a timeout, rate limiting or a server error. */
const isRetryableStatus = (status: number) => status === 403 || status === 408 || status === 429 || status >= 500

/**
 * Polls to detect when this device has been approved by a trusted device.
 * Calls `checkApproval` at a regular interval; on success, fires `onApproved`.
 * A 403 carrying `DEVICE_DISCONNECTED` (device revoked) fires `onRevoked` and stops polling.
 * Any other 403 — a session not yet bound to this device — is transient and keeps polling.
 * Receiver verification failures notify the waiting UI and keep polling so an honest retry can recover.
 * Transient failures (no connection, timeouts, retryable statuses) stay silent. Any other failure
 * goes to `onError`, so the screen can say what is wrong, and polling continues.
 */
export const useApprovalPolling = ({
  enabled,
  checkApproval,
  onApproved,
  onRevoked,
  onDenied,
  onVerificationFailed,
  onError,
  intervalMs = 3000,
}: UseApprovalPollingOptions) => {
  const isCheckingRef = useRef(false)
  const onApprovedRef = useRef(onApproved)
  onApprovedRef.current = onApproved
  const onRevokedRef = useRef(onRevoked)
  onRevokedRef.current = onRevoked
  const onDeniedRef = useRef(onDenied)
  onDeniedRef.current = onDenied
  const onVerificationFailedRef = useRef(onVerificationFailed)
  onVerificationFailedRef.current = onVerificationFailed
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const checkApprovalRef = useRef(checkApproval)
  checkApprovalRef.current = checkApproval

  // Legitimate useEffect: manages a polling interval (external side effect) with cleanup.
  // Refs avoid stale closures without adding callbacks to the dependency array.
  useEffect(() => {
    if (!enabled) {
      return
    }

    let cancelled = false

    const check = async () => {
      if (isCheckingRef.current) {
        return
      }
      isCheckingRef.current = true

      try {
        const approved = await checkApprovalRef.current()
        if (approved && !cancelled) {
          clearInterval(intervalId)
          onApprovedRef.current()
        }
      } catch (err) {
        if (err instanceof DeviceApprovalError && err.reason === 'recipient-unverified' && !cancelled) {
          onVerificationFailedRef.current?.()
          return
        }
        if (err instanceof HttpError && !cancelled) {
          const body =
            err.response.status === 403
              ? ((await err.response
                  .clone()
                  .json()
                  .catch(() => null)) as { code?: string } | null)
              : null
          // Reading the body awaited, so the effect may have been cleaned up meanwhile.
          if (cancelled) {
            return
          }
          if (body?.code === 'DEVICE_DISCONNECTED') {
            clearInterval(intervalId)
            onRevokedRef.current?.()
            return
          }
          if (err.response.status === 422) {
            clearInterval(intervalId)
            onDeniedRef.current?.()
            return
          }
        }
        const transient =
          err instanceof HttpError
            ? isRetryableStatus(err.response.status)
            : (err instanceof Error && isFetchNetworkError(err)) ||
              err instanceof EncryptionRequestTimeoutError ||
              err instanceof EncryptionOperationCancelledError
        if (!transient && err instanceof Error && !cancelled) {
          onErrorRef.current?.(err)
        }
      } finally {
        isCheckingRef.current = false
      }
    }

    const intervalId = setInterval(check, intervalMs)

    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [enabled, intervalMs])
}
