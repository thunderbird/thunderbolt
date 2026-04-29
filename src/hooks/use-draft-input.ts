/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react'
import { useLocalStorage } from './use-local-storage'

const draftKeyPrefix = 'draft:'

/**
 * Persists prompt input text to localStorage, keyed by chat thread ID.
 * Debounces writes so rapid typing doesn't thrash storage.
 * Returns [input, setInput, clearDraft] — drop-in replacement for useState('').
 */
export const useDraftInput = (chatThreadId: string, { persist = true }: { persist?: boolean } = {}) => {
  const [input, setInput] = useLocalStorage(`${draftKeyPrefix}${chatThreadId}`, '', {
    debounceMs: 300,
    disabled: !persist,
  })

  const clearDraft = useCallback(() => {
    setInput('', { immediate: true })
  }, [setInput])

  return [input, setInput, clearDraft] as const
}
