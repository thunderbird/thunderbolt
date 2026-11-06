/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useEffect } from 'react'
import { create, useStore, type StoreApi } from 'zustand'
import type { Update } from '@tauri-apps/plugin-updater'
import { isDesktop } from '@/lib/platform'
import { getPowerSyncInstance } from '@/db/powersync/sync-state'
import { setPostUpdateFlag, clearPostUpdateFlag } from '@/lib/post-update-redirect'

export type UpdateStatus =
  | 'initial'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'restarting'
  | 'error'

/** Shared action copy for Settings and the minimum-version blocker; resolve at render time. */
export const desktopUpdateActionLabel: Record<UpdateStatus, MessageDescriptor> = {
  initial: msg`Check for updates`,
  idle: msg`Check for updates`,
  checking: msg`Checking…`,
  available: msg`Download update`,
  downloading: msg`Downloading…`,
  ready: msg`Restart to update`,
  restarting: msg`Restart to update`,
  error: msg`Retry`,
}

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
  | { type: 'RESTART_START' }
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
      if (
        state.status === 'checking' ||
        state.status === 'downloading' ||
        state.status === 'ready' ||
        state.status === 'restarting' ||
        state.errorPhase === 'restart'
      ) {
        return state
      }
      return { ...state, status: 'checking', error: null, errorPhase: null }
    case 'CHECK_SUCCESS':
      if (state.status !== 'checking') {
        return state
      }
      return {
        ...state,
        status: action.update ? 'available' : 'idle',
        update: action.update,
      }
    case 'DOWNLOAD_START':
      if (
        !state.update ||
        (state.status !== 'available' && !(state.status === 'error' && state.errorPhase === 'download'))
      ) {
        return state
      }
      return { ...state, status: 'downloading', downloadProgress: 0, error: null, errorPhase: null }
    case 'RESTART_START':
      if (state.status !== 'ready' && !(state.status === 'error' && state.errorPhase === 'restart')) {
        return state
      }
      return { ...state, status: 'restarting', error: null, errorPhase: null }
    case 'DOWNLOAD_PROGRESS':
      if (state.status !== 'downloading') {
        return state
      }
      return { ...state, downloadProgress: action.progress }
    case 'DOWNLOAD_SUCCESS':
      if (state.status !== 'downloading') {
        return state
      }
      return { ...state, status: 'ready', downloadProgress: 100 }
    case 'ERROR':
      if (
        state.status !== ({ check: 'checking', download: 'downloading', restart: 'restarting' } as const)[action.phase]
      ) {
        return state
      }
      return { ...state, status: 'error', error: action.error, errorPhase: action.phase }
  }
}

/**
 * Maps an update status to the primary user action — the single source of the
 * check → download → restart progression shared by every update surface (toast,
 * settings, the min-version blocker). Any non-actionable status (re)checks.
 */
export const selectUpdateAction = (
  status: UpdateStatus,
  errorPhase: UpdateErrorPhase | null = null,
): 'download' | 'restart' | 'check' => {
  if (status === 'available' || (status === 'error' && errorPhase === 'download')) {
    return 'download'
  }
  if (status === 'ready' || (status === 'error' && errorPhase === 'restart')) {
    return 'restart'
  }
  return 'check'
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

export type DesktopUpdateState = UpdateState & {
  checkForUpdates: () => Promise<void>
  downloadAndInstall: () => Promise<void>
  restartApp: () => Promise<void>
  /** The status-driven primary action shared by every update surface (toast,
   *  settings, the min-version blocker): download when an update is available,
   *  restart when one is ready, otherwise (re)check. */
  primaryAction: () => Promise<void>
}

type UpdateServices = {
  isDesktop: () => boolean
  check: () => Promise<Update | null>
  disconnect: () => Promise<void> | undefined
  relaunch: () => Promise<void>
}

/** Own the update lifecycle across every UI surface, admitting native work synchronously. */
export const createDesktopUpdateStore = (services: UpdateServices) => {
  const dispatch = (action: UpdateAction) => {
    const current = store.getState()
    const next = updateReducer(current, action)
    if (next === current) {
      return false
    }
    store.setState(next)
    return true
  }

  const checkForUpdates = async () => {
    if (!services.isDesktop() || !dispatch({ type: 'CHECK_START' })) {
      return
    }
    const previous = store.getState().update
    try {
      const update = await services.check()
      dispatch({ type: 'CHECK_SUCCESS', update })
      if (previous && previous !== update) {
        try {
          await previous.close()
        } catch (err) {
          console.error('Failed to release superseded update:', err)
        }
      }
    } catch (err) {
      console.error('Failed to check for updates:', err)
      dispatch({ type: 'ERROR', error: extractErrorMessage(err, 'Failed to check for updates'), phase: 'check' })
    }
  }

  const downloadAndInstall = async () => {
    const { update } = store.getState()
    if (!update || !dispatch({ type: 'DOWNLOAD_START' })) {
      return
    }
    let contentLength = 0
    let bytesDownloaded = 0
    let acceptingProgress = true
    try {
      await update.downloadAndInstall((event) => {
        // Native channel messages can arrive after rejection and a retry.
        if (!acceptingProgress) {
          return
        }
        if (event.event === 'Started') {
          contentLength = event.data.contentLength ?? 0
          bytesDownloaded = 0
        } else if (event.event === 'Progress') {
          bytesDownloaded += event.data.chunkLength
          if (contentLength > 0) {
            const progress = Math.min(Math.round((bytesDownloaded / contentLength) * 100), 100)
            dispatch({ type: 'DOWNLOAD_PROGRESS', progress })
          }
        } else if (event.event === 'Finished') {
          dispatch({ type: 'DOWNLOAD_PROGRESS', progress: 100 })
        }
      })
      dispatch({ type: 'DOWNLOAD_SUCCESS' })
    } catch (err) {
      console.error('Failed to download update:', err)
      dispatch({ type: 'ERROR', error: extractErrorMessage(err, 'Failed to download update'), phase: 'download' })
    } finally {
      acceptingProgress = false
    }
  }

  const restartApp = async () => {
    if (!dispatch({ type: 'RESTART_START' })) {
      return
    }
    try {
      // A disconnect error must not prevent applying an already installed update.
      try {
        await services.disconnect()
      } catch (err) {
        console.error('Failed to disconnect PowerSync before relaunch:', err)
      }
      setPostUpdateFlag()
      await services.relaunch()
    } catch (err) {
      clearPostUpdateFlag()
      console.error('Failed to restart app:', err)
      dispatch({ type: 'ERROR', error: extractErrorMessage(err, 'Failed to restart app'), phase: 'restart' })
    }
  }

  const primaryAction = async () => {
    const { status, errorPhase } = store.getState()
    const actions = { check: checkForUpdates, download: downloadAndInstall, restart: restartApp }
    await actions[selectUpdateAction(status, errorPhase)]()
  }

  const store = create<DesktopUpdateState>(() => ({
    ...initialUpdateState,
    checkForUpdates,
    downloadAndInstall,
    restartApp,
    primaryAction,
  }))
  return store
}

const useUpdateStore = createDesktopUpdateStore({
  isDesktop: () => isDesktop(),
  check: async () => {
    // Keep desktop-only plugins out of the web entry bundle.
    const { check } = await import('@tauri-apps/plugin-updater')
    return check()
  },
  disconnect: () => getPowerSyncInstance()?.disconnect(),
  relaunch: async () => {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  },
})

/** Subscribe to the shared desktop updater and schedule one automatic check per session. */
export const useDesktopUpdate = (store: StoreApi<DesktopUpdateState> = useUpdateStore): DesktopUpdateState => {
  const state = useStore(store)
  useEffect(() => {
    if (!isDesktop() || state.status !== 'initial') {
      return
    }
    const timeout = setTimeout(() => {
      if (store.getState().status === 'initial') {
        void store.getState().checkForUpdates()
      }
    }, 5000)
    return () => clearTimeout(timeout)
  }, [store, state.status])
  return state
}
