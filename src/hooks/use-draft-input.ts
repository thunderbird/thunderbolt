import { useCallback, useEffect, useRef, useState } from 'react'

const draftKeyPrefix = 'draft:'
const debounceMs = 300

/** Get the localStorage key for a chat thread's draft. */
const getDraftKey = (chatThreadId: string) => `${draftKeyPrefix}${chatThreadId}`

/** Read a draft from localStorage. */
const readDraft = (chatThreadId: string): string => localStorage.getItem(getDraftKey(chatThreadId)) ?? ''

/** Write a draft to localStorage (or remove if empty). */
const writeDraft = (chatThreadId: string, value: string) => {
  const key = getDraftKey(chatThreadId)
  if (value) {
    localStorage.setItem(key, value)
  } else {
    localStorage.removeItem(key)
  }
}

/**
 * Persists prompt input text to localStorage, keyed by chat thread ID.
 * Debounces writes so rapid typing doesn't thrash storage.
 * Returns [input, setInput, clearDraft] — drop-in replacement for useState('').
 */
export const useDraftInput = (chatThreadId: string) => {
  const [input, setInputState] = useState(() => readDraft(chatThreadId))
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chatThreadIdRef = useRef(chatThreadId)

  // When the chat thread changes, load that thread's draft
  useEffect(() => {
    chatThreadIdRef.current = chatThreadId
    setInputState(readDraft(chatThreadId))

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [chatThreadId])

  const setInput = useCallback((value: string) => {
    setInputState(value)

    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }

    timerRef.current = setTimeout(() => {
      writeDraft(chatThreadIdRef.current, value)
      timerRef.current = null
    }, debounceMs)
  }, [])

  const clearDraft = useCallback(() => {
    setInputState('')
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    writeDraft(chatThreadIdRef.current, '')
  }, [])

  return [input, setInput, clearDraft] as const
}
