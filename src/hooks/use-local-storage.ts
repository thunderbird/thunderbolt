import { useEffect, useState } from 'react'

/**
 * Custom hook for managing localStorage with React state synchronization
 * @param key The localStorage key
 * @param defaultValue The default value if key doesn't exist in localStorage
 * @returns [value, setter] tuple similar to useState
 *
 * @example
 * ```tsx
 * const [selectedSse, setSelectedSse] = useLocalStorage('message-simulator-sse', 'apple')
 *
 * // Use the value
 * console.log(selectedSse) // current value or default
 *
 * // Update the value
 * setSelectedSse('banana')
 * ```
 */
export const useLocalStorage = <T>(key: string, defaultValue: T): [T, (value: T) => void] => {
  // Initialize state with value from localStorage or default
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key)
      return item ? JSON.parse(item) : defaultValue
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error)
      return defaultValue
    }
  })

  // Function to update both state and localStorage
  const setValue = (value: T) => {
    try {
      // Update state
      setStoredValue(value)
      // Update localStorage
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch (error) {
      console.warn(`Error setting localStorage key "${key}":`, error)
    }
  }

  // Listen for changes to this localStorage key in other tabs/windows
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        try {
          setStoredValue(JSON.parse(e.newValue))
        } catch (error) {
          console.warn(`Error parsing localStorage value for key "${key}":`, error)
        }
      }
    }

    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [key])

  return [storedValue, setValue]
}
