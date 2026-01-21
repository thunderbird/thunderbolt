import { useState, useEffect, useCallback } from 'react'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isDesktop } from '@/lib/platform'

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export type DesktopUpdateState = {
  status: UpdateStatus
  update: Update | null
  error: string | null
  downloadProgress: number
  checkForUpdates: () => Promise<void>
  downloadAndInstall: () => Promise<void>
  restartApp: () => Promise<void>
}

/**
 * Hook to manage desktop application updates using Tauri's updater plugin.
 * Only active on desktop platforms (macOS, Windows, Linux).
 */
export const useDesktopUpdate = (): DesktopUpdateState => {
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [update, setUpdate] = useState<Update | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloadProgress, setDownloadProgress] = useState(0)

  const checkForUpdates = useCallback(async () => {
    if (!isDesktop()) return

    setStatus('checking')
    setError(null)

    try {
      const availableUpdate = await check()

      if (availableUpdate) {
        setUpdate(availableUpdate)
      }

      setStatus(availableUpdate ? 'available' : 'idle')
    } catch (err) {
      console.error('Failed to check for updates:', err)
      setError(err instanceof Error ? err.message : 'Failed to check for updates')
      setStatus('error')
    }
  }, [])

  const downloadAndInstall = useCallback(async () => {
    if (!update) return

    setStatus('downloading')
    setDownloadProgress(0)

    let contentLength = 0
    let bytesDownloaded = 0

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started' && event.data.contentLength) {
          contentLength = event.data.contentLength
          bytesDownloaded = 0
        } else if (event.event === 'Progress') {
          bytesDownloaded += event.data.chunkLength
          if (contentLength > 0) {
            const percentage = Math.round((bytesDownloaded / contentLength) * 100)
            setDownloadProgress(Math.min(percentage, 100))
          }
        } else if (event.event === 'Finished') {
          setDownloadProgress(100)
        }
      })

      setStatus('ready')
    } catch (err) {
      console.error('Failed to download update:', err)
      setError(err instanceof Error ? err.message : 'Failed to download update')
      setStatus('error')
    }
  }, [update])

  const restartApp = useCallback(async () => {
    try {
      await relaunch()
    } catch (err) {
      console.error('Failed to restart app:', err)
      setError(err instanceof Error ? err.message : 'Failed to restart app')
      setStatus('error')
    }
  }, [])

  // Check for updates on mount (desktop only)
  useEffect(() => {
    if (!isDesktop()) return

    // Delay initial check to not block app startup
    const timeout = setTimeout(() => {
      checkForUpdates()
    }, 5000)

    return () => clearTimeout(timeout)
  }, [checkForUpdates])

  return {
    status,
    update,
    error,
    downloadProgress,
    checkForUpdates,
    downloadAndInstall,
    restartApp,
  }
}
