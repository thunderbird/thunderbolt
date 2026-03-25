import { useEffect, useRef, useState } from 'react'

type UseApprovalPollingOptions = {
  enabled: boolean
  checkApproval: () => Promise<boolean>
  onApproved: () => void
  intervalMs?: number
}

/**
 * Polls to detect when this device has been approved by a trusted device.
 * Calls `checkApproval` at a regular interval; on success, fires `onApproved`.
 * Errors are silently ignored — the manual Continue button serves as fallback.
 */
export const useApprovalPolling = ({
  enabled,
  checkApproval,
  onApproved,
  intervalMs = 3000,
}: UseApprovalPollingOptions) => {
  const [isPolling, setIsPolling] = useState(false)
  const isCheckingRef = useRef(false)
  const onApprovedRef = useRef(onApproved)
  onApprovedRef.current = onApproved
  const checkApprovalRef = useRef(checkApproval)
  checkApprovalRef.current = checkApproval

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
  }, [enabled, intervalMs])

  return { isPolling }
}
