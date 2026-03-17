import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Hook for copying text to clipboard with a temporary "copied" feedback state.
 * Handles cleanup on unmount to avoid stale timer updates.
 * @param resetMs - How long `isCopied` stays true (default: 2000ms)
 * @returns `copy(text)` function (resolves to true on success) and `isCopied` state
 */
export const useCopyToClipboard = (resetMs = 2000) => {
  const [isCopied, setIsCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        setIsCopied(true)
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
        }
        timeoutRef.current = setTimeout(() => setIsCopied(false), resetMs)
        return true
      } catch (error) {
        console.error('Error copying to clipboard:', error)
        return false
      }
    },
    [resetMs],
  )

  return { copy, isCopied }
}
