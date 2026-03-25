import { useEffect, useRef, useState } from 'react'
import { useHttpClient } from '@/contexts'
import { checkApprovalAndUnwrap } from '@/services/encryption'

type UseApprovalPollingOptions = {
  enabled: boolean
  onApproved: () => void
  intervalMs?: number
}

/**
 * Polls the server to detect when this device has been approved by a trusted device.
 * Calls `checkApprovalAndUnwrap` at a regular interval; on success, fires `onApproved`.
 * Errors are silently ignored — the manual Continue button serves as fallback.
 */
export const useApprovalPolling = ({ enabled, onApproved, intervalMs = 3000 }: UseApprovalPollingOptions) => {
  const httpClient = useHttpClient()
  const [isPolling, setIsPolling] = useState(false)
  const isCheckingRef = useRef(false)
  const onApprovedRef = useRef(onApproved)
  onApprovedRef.current = onApproved

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
        const approved = await checkApprovalAndUnwrap(httpClient)
        if (approved && !cancelled) {
          clearInterval(intervalId)
          setIsPolling(false)
          onApprovedRef.current()
        }
      } catch {
        // Silently continue — manual button is fallback
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
  }, [enabled, httpClient, intervalMs])

  return { isPolling }
}
