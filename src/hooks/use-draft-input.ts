import { useCallback } from 'react'
import { useLocalStorage } from './use-local-storage'

const draftKeyPrefix = 'draft:'

/**
 * Persists prompt input text to localStorage, keyed by chat thread ID.
 * Debounces writes so rapid typing doesn't thrash storage.
 * Returns [input, setInput, clearDraft] — drop-in replacement for useState('').
 */
export const useDraftInput = (chatThreadId: string) => {
  const [input, setInput] = useLocalStorage(`${draftKeyPrefix}${chatThreadId}`, '', { debounceMs: 300 })

  const clearDraft = useCallback(() => {
    setInput('', { immediate: true })
  }, [setInput])

  return [input, setInput, clearDraft] as const
}
