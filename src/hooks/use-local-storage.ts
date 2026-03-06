import { useCallback, useEffect, useRef, useState } from 'react'

const defaultDebounceMs = 0

/**
 * React hook that syncs state to localStorage with optional debounced writes.
 * Removes the key when value equals the default, keeping localStorage clean.
 *
 * @param key - localStorage key
 * @param defaultValue - returned when key is absent; also used to detect "empty" state for cleanup
 * @param options.debounceMs - debounce writes by this many ms (0 = immediate)
 */
export const useLocalStorage = (key: string, defaultValue: string, options?: { debounceMs?: number }) => {
  const debounceMs = options?.debounceMs ?? defaultDebounceMs
  const [value, setValueState] = useState(() => localStorage.getItem(key) ?? defaultValue)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingValueRef = useRef<string | null>(null)
  const keyRef = useRef(key)

  // When key changes, load the new key's value and flush any pending write for the old key
  useEffect(() => {
    // Capture current key before updating — cleanup needs to flush writes to THIS key,
    // not the next one (keyRef.current will already point to the new key by cleanup time)
    const currentKey = key
    keyRef.current = key
    setValueState(localStorage.getItem(key) ?? defaultValue)

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (pendingValueRef.current !== null) {
        writeToStorage(currentKey, pendingValueRef.current, defaultValue)
        pendingValueRef.current = null
      }
    }
  }, [key, defaultValue])

  const setValue = useCallback(
    (next: string, setOptions?: { immediate?: boolean }) => {
      setValueState(next)

      if (debounceMs === 0 || setOptions?.immediate) {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        pendingValueRef.current = null
        writeToStorage(keyRef.current, next, defaultValue)
        return
      }

      pendingValueRef.current = next

      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }

      timerRef.current = setTimeout(() => {
        writeToStorage(keyRef.current, next, defaultValue)
        timerRef.current = null
        pendingValueRef.current = null
      }, debounceMs)
    },
    [debounceMs, defaultValue],
  )

  return [value, setValue] as const
}

/** Write to localStorage, removing the key when value matches the default. */
const writeToStorage = (key: string, value: string, defaultValue: string) => {
  if (value === defaultValue) {
    localStorage.removeItem(key)
  } else {
    localStorage.setItem(key, value)
  }
}
