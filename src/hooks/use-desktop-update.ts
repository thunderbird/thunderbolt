/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useCallback } from 'react'
import { create } from 'zustand'
import type { Update } from '@tauri-apps/plugin-updater'
import { isDesktop } from '@/lib/platform'
import { getPowerSyncInstance } from '@/db/powersync/sync-state'
import { setPostUpdateFlag, clearPostUpdateFlag } from '@/lib/post-update-redirect'

export type UpdateStatus = 'initial' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export type UpdateErrorPhase = 'check' | 'download' | 'restart'

export type UpdateState = {
  status: UpdateStatus
  update: Update | null
  error: string | null
  errorPhase: UpdateErrorPhase | null
  downloadProgress: number
}

export type UpdateAction =
  | { type: 'CHECK_START' }
  | { type: 'CHECK_SUCCESS'; update: Update | null }
  | { type: 'DOWNLOAD_START' }
  | { type: 'DOWNLOAD_PROGRESS'; progress: number }
  | { type: 'DOWNLOAD_SUCCESS' }
  | { type: 'ERROR'; error: string; phase: UpdateErrorPhase }

export const initialUpdateState: UpdateState = {
  status: 'initial',
  update: null,
  error: null,
  errorPhase: null,
  downloadProgress: 0,
}

export const updateReducer = (state: UpdateState, action: UpdateAction): UpdateState => {
  switch (action.type) {
    case 'CHECK_START':
      return { ...state, status: 'checking', error: null, errorPhase: null }
    case 'CHECK_SUCCESS':
      return {
        ...state,
        status: action.update ? 'available' : 'idle',
        update: action.update,
      }
    case 'DOWNLOAD_START':
      return { ...state, status: 'downloading', downloadProgress: 0 }
    case 'DOWNLOAD_PROGRESS':
      return { ...state, downloadProgress: action.progress }
    case 'DOWNLOAD_SUCCESS':
      return { ...state, status: 'ready', downloadProgress: 100 }
    case 'ERROR':
      return { ...state, status: 'error', error: action.error, errorPhase: action.phase }
  }
}

const extractErrorMessage = (err: unknown, fallback: string): string => {
  if (err instanceof Error) {
    return err.message
  }
  if (typeof err === 'string') {
    return err
  }
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  try {
    const serialized = JSON.stringify(err)
    return serialized && serialized !== '{}' ? serialized : fallback
  } catch {
    return fallback
  }
}

type UpdateStore = UpdateState & {
  dispatch: (action: UpdateAction) => void
}

const useUpdateStore = create<UpdateStore>((set) => ({
  ...initialUpdateState,
  dispatch: (action) => set((state) => updateReducer(state, action)),
}))

export type DesktopUpdateState = UpdateState & {
  checkForUpdates: () => Promise<void>
  downloadAndInstall: () => Promise<void>
  restartApp: () => Promise<void>
}

let didAutoCheck = false

/**
 * Hook to manage desktop application updates using Tauri's updater plugin.
 * Only active on desktop platforms (macOS, Windows, Linux).
 * State lives in a shared zustand store so multiple call sites (toast,
 * Settings page) stay in sync.
 */
export const useDesktopUpdate = (): DesktopUpdateState => {
  const status = useUpdateStore((s) => s.status)
  const update = useUpdateStore((s) => s.update)
  const error = useUpdateStore((s) => s.error)
  const errorPhase = useUpdateStore((s) => s.errorPhase)
  const downloadProgress = useUpdateStore((s) => s.downloadProgress)

  const checkForUpdates = useCallback(async () => {
    if (!isDesktop()) {
      return
    }

    // Don't interrupt an in-flight check, download, or post-download ready state.
    const current = useUpdateStore.getState().status
    if (current === 'checking' || current === 'downloading' || current === 'ready') {
      return
    }

    const { dispatch } = useUpdateStore.getState()
    dispatch({ type: 'CHECK_START' })

    try {
      // Import the desktop-only updater plugin lazily so it stays out of the web
      // entry bundle (this path is guarded by isDesktop above).
      const { check } = await import('@tauri-apps/plugin-updater')
      const availableUpdate = await check()
      dispatch({ type: 'CHECK_SUCCESS', update: availableUpdate })
    } catch (err) {
      console.error('Failed to check for updates:', err)
      useUpdateStore.getState().dispatch({
        type: 'ERROR',
        error: extractErrorMessage(err, 'Failed to check for updates'),
        phase: 'check',
      })
    }
  }, [])

  const downloadAndInstall = useCallback(async () => {
    const current = useUpdateStore.getState().update
    if (!current) {
      return
    }

    const { dispatch } = useUpdateStore.getState()
    dispatch({ type: 'DOWNLOAD_START' })

    let contentLength = 0
    let bytesDownloaded = 0

    try {
      await current.downloadAndInstall((event) => {
        if (event.event === 'Started' && event.data.contentLength) {
          contentLength = event.data.contentLength
          bytesDownloaded = 0
        } else if (event.event === 'Progress') {
          bytesDownloaded += event.data.chunkLength
          if (contentLength > 0) {
            const percentage = Math.round((bytesDownloaded / contentLength) * 100)
            useUpdateStore.getState().dispatch({ type: 'DOWNLOAD_PROGRESS', progress: Math.min(percentage, 100) })
          }
        } else if (event.event === 'Finished') {
          useUpdateStore.getState().dispatch({ type: 'DOWNLOAD_PROGRESS', progress: 100 })
        }
      })

      useUpdateStore.getState().dispatch({ type: 'DOWNLOAD_SUCCESS' })
    } catch (err) {
      console.error('Failed to download update:', err)
      useUpdateStore.getState().dispatch({
        type: 'ERROR',
        error: extractErrorMessage(err, 'Failed to download update'),
        phase: 'download',
      })
    }
  }, [])

  const restartApp = useCallback(async () => {
    try {
      // Best-effort disconnect — don't block the relaunch if PowerSync fails
      try {
        await getPowerSyncInstance()?.disconnect()
      } catch (err) {
        console.error('Failed to disconnect PowerSync before relaunch:', err)
      }
      // Signal the new process to reset navigation (WebView may restore stale route)
      setPostUpdateFlag()
      // Lazily import the desktop-only process plugin so it stays out of the web
      // entry bundle — this only runs from the desktop update flow.
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (err) {
      // Clear the flag so a stale flag doesn't force-redirect on next manual launch
      clearPostUpdateFlag()
      console.error('Failed to restart app:', err)
      useUpdateStore.getState().dispatch({
        type: 'ERROR',
        error: extractErrorMessage(err, 'Failed to restart app'),
        phase: 'restart',
      })
    }
  }, [])

  // Auto-check once per session on desktop. Guarded so mounting the hook in
  // multiple places (toast + Settings) doesn't fire repeat checks. The guard
  // is set inside the timeout so an early unmount re-arms the check on the
  // next mount instead of silently swallowing it for the session.
  useEffect(() => {
    if (!isDesktop() || didAutoCheck) {
      return
    }

    const timeout = setTimeout(() => {
      didAutoCheck = true
      checkForUpdates()
    }, 5000)

    return () => clearTimeout(timeout)
  }, [checkForUpdates])

  return {
    status,
    update,
    error,
    errorPhase,
    downloadProgress,
    checkForUpdates,
    downloadAndInstall,
    restartApp,
  }
}
