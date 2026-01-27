import { useSyncExternalStore } from 'react'

const subscribe = (callback: () => void) => {
  window.addEventListener('online', callback)
  window.addEventListener('offline', callback)
  return () => {
    window.removeEventListener('online', callback)
    window.removeEventListener('offline', callback)
  }
}

const getSnapshot = () => navigator.onLine

const getServerSnapshot = () => true

/**
 * Returns whether the browser is currently online.
 * Reactively updates when connectivity changes.
 */
export const useOnlineStatus = () => useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
