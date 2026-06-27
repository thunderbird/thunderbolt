/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useCallback } from 'react'
import { create } from 'zustand'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isDesktop } from '@/lib/platform'
import { getPowerSyncInstance } from '@/db/powersync/sync-state'
import { setPostUpdateFlag, clearPostUpdateFlag } from '@/lib/post-update-redirect'

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export type UpdateState = {
  status: UpdateStatus
  update: Update | null
  error: string | null
  downloadProgress: number
}

export type UpdateAction =
  | { type: 'CHECK_START' }
  | { type: 'CHECK_SUCCESS'; update: Update | null }
  | { type: 'DOWNLOAD_START' }
  | { type: 'DOWNLOAD_PROGRESS'; progress: number }
  | { type: 'DOWNLOAD_SUCCESS' }
  | { type: 'ERROR'; error: string }

export const initialUpdateState: UpdateState = {
  status: 'idle',
  update: null,
  error: null,
  downloadProgress: 0,
}

export const updateReducer = (state: UpdateState, action: UpdateAction): UpdateState => {
  switch (action.type) {
    case 'CHECK_START':
      return { ...state, status: 'checking', error: null }
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
      return { ...state, status: 'error', error: action.error }
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
  const downloadProgress = useUpdateStore((s) => s.downloadProgress)

  const checkForUpdates = useCallback(async () => {
    if (!isDesktop()) {
      return
    }

    const { dispatch } = useUpdateStore.getState()
    dispatch({ type: 'CHECK_START' })

    try {
      const availableUpdate = await check()
      dispatch({ type: 'CHECK_SUCCESS', update: availableUpdate })
    } catch (err) {
      console.error('Failed to check for updates:', err)
      useUpdateStore
        .getState()
        .dispatch({ type: 'ERROR', error: extractErrorMessage(err, 'Failed to check for updates') })
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
      useUpdateStore
        .getState()
        .dispatch({ type: 'ERROR', error: extractErrorMessage(err, 'Failed to download update') })
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
      await relaunch()
    } catch (err) {
      // Clear the flag so a stale flag doesn't force-redirect on next manual launch
      clearPostUpdateFlag()
      console.error('Failed to restart app:', err)
      useUpdateStore.getState().dispatch({ type: 'ERROR', error: extractErrorMessage(err, 'Failed to restart app') })
    }
  }, [])

  // Auto-check once per session on desktop. Guarded so mounting the hook in
  // multiple places (toast + Settings) doesn't fire repeat checks.
  useEffect(() => {
    if (!isDesktop() || didAutoCheck) {
      return
    }
    didAutoCheck = true

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
