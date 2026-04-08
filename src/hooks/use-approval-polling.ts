import { useEffect, useRef, useState } from 'react'
import { HTTPError } from 'ky'

type UseApprovalPollingOptions = {
  enabled: boolean
  checkApproval: () => Promise<boolean>
  onApproved: () => void
  onRevoked?: () => void
  intervalMs?: number
}

/**
 * Polls to detect when this device has been approved by a trusted device.
 * Calls `checkApproval` at a regular interval; on success, fires `onApproved`.
 * If a 403 is received (device revoked), fires `onRevoked` and stops polling.
 * Other errors are silently ignored — the manual Continue button serves as fallback.
 */
export const useApprovalPolling = ({
  enabled,
  checkApproval,
  onApproved,
  onRevoked,
  intervalMs = 3000,
}: UseApprovalPollingOptions) => {
  const [isPolling, setIsPolling] = useState(false)
  const isCheckingRef = useRef(false)
  const onApprovedRef = useRef(onApproved)
  onApprovedRef.current = onApproved
  const onRevokedRef = useRef(onRevoked)
  onRevokedRef.current = onRevoked
  const checkApprovalRef = useRef(checkApproval)
  checkApprovalRef.current = checkApproval

  // Legitimate useEffect: manages a polling interval (external side effect) with cleanup.
  // Refs avoid stale closures without adding callbacks to the dependency array.
  useEffect(() => {
    if (!enabled) {
      setIsPolling(false)
      return
    }

    let cancelled = false
    setIsPolling(true)

    const check = async () => {
      if (isCheckingRef.current) {
        return
      }
      isCheckingRef.current = true

      try {
        const approved = await checkApprovalRef.current()
        if (approved && !cancelled) {
          clearInterval(intervalId)
          setIsPolling(false)
          onApprovedRef.current()
        }
      } catch (err) {
        if (err instanceof HTTPError && err.response.status === 403 && !cancelled) {
          clearInterval(intervalId)
          setIsPolling(false)
          onRevokedRef.current?.()
          return
        }
        // Silently continue for other errors — manual button is fallback
      } finally {
        isCheckingRef.current = false
      }
    }

    const intervalId = setInterval(check, intervalMs)

    return () => {
      cancelled = true
      clearInterval(intervalId)
      setIsPolling(false)
    }
  }, [enabled, intervalMs])

  return { isPolling }
}
