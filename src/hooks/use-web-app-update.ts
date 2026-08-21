/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import {
  applyWaitingUpdate,
  checkForServiceWorkerUpdate,
  isServiceWorkerSupported,
  registerServiceWorker,
  startUpdatePolling,
} from '@/lib/service-worker'

export type WebUpdateStatus = 'idle' | 'checking' | 'available'

type WebUpdateStore = {
  status: WebUpdateStatus
  registration: ServiceWorkerRegistration | null
  dismissed: boolean
  setStatus: (status: WebUpdateStatus) => void
  setRegistration: (registration: ServiceWorkerRegistration | null) => void
  setDismissed: (dismissed: boolean) => void
}

/** Shared so the notification and the Settings section show one truth. */
const useStore = create<WebUpdateStore>((set) => ({
  status: 'idle',
  registration: null,
  dismissed: false,
  setStatus: (status) => set({ status }),
  setRegistration: (registration) => set({ registration }),
  setDismissed: (dismissed) => set({ dismissed }),
}))

/** Registration and polling are per-document, not per-component: this hook mounts
 *  in both the notification and the Settings page, and neither should race to
 *  register or double the poll rate. */
let registerOnce: Promise<ServiceWorkerRegistration | undefined> | undefined
let pollingTeardown: (() => void) | undefined
let mountCount = 0

/** Test seam — resets the module-level latches. */
export const resetWebAppUpdateForTests = (): void => {
  registerOnce = undefined
  pollingTeardown?.()
  pollingTeardown = undefined
  mountCount = 0
  useStore.setState({ status: 'idle', registration: null, dismissed: false })
}

export type WebAppUpdateState = {
  status: WebUpdateStatus
  /** True once a newer build is installed and waiting for the user. */
  updateAvailable: boolean
  /** False until the worker is registered, so callers can disable a check button
   *  rather than offer one that silently does nothing. */
  ready: boolean
  dismissed: boolean
  applyUpdate: () => void
  checkForUpdates: () => Promise<void>
  dismiss: () => void
}

/**
 * Web/PWA counterpart to `useDesktopUpdate`.
 *
 * Static hosting gives the browser no version to compare, so "is there a new
 * build?" is answered by the service worker: it re-fetches `/sw.js`, and a
 * changed precache manifest (which embeds every hashed asset name) means a new
 * deploy. Until the user accepts, the running bundle is left alone.
 */
export const useWebAppUpdate = (): WebAppUpdateState => {
  const status = useStore((s) => s.status)
  const registration = useStore((s) => s.registration)
  const dismissed = useStore((s) => s.dismissed)

  useEffect(() => {
    if (!isServiceWorkerSupported()) {
      return
    }

    mountCount += 1

    registerOnce ??= registerServiceWorker({
      onUpdateReady: () => {
        // A build that landed after the user dismissed an earlier prompt is a
        // new event, so un-dismiss to surface it again.
        useStore.setState({ status: 'available', dismissed: false })
      },
    })

    void registerOnce.then((result) => {
      if (!result) {
        return
      }
      useStore.getState().setRegistration(result)
      pollingTeardown ??= startUpdatePolling(result)
    })

    return () => {
      mountCount -= 1
      // Only the last call site tearing down stops the shared poller; otherwise
      // navigating away from Settings would silence update checks app-wide.
      if (mountCount === 0) {
        pollingTeardown?.()
        pollingTeardown = undefined
      }
    }
  }, [])

  const checkForUpdates = useCallback(async () => {
    const current = useStore.getState()
    if (current.status === 'checking' || !current.registration) {
      return
    }
    current.setStatus('checking')
    await checkForServiceWorkerUpdate(current.registration)
    // `onUpdateReady` flips this to 'available' when a new worker installs;
    // don't clobber that if it already fired during the await.
    if (useStore.getState().status === 'checking') {
      useStore.getState().setStatus('idle')
    }
  }, [])

  const applyUpdate = useCallback(() => {
    const current = useStore.getState().registration
    if (current) {
      applyWaitingUpdate(current)
    }
  }, [])

  const dismiss = useCallback(() => {
    useStore.getState().setDismissed(true)
  }, [])

  return {
    status,
    updateAvailable: status === 'available',
    ready: registration !== null,
    dismissed,
    applyUpdate,
    checkForUpdates,
    dismiss,
  }
}
