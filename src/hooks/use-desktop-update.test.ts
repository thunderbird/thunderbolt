/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import * as platform from '@/lib/platform'
import { getClock } from '@/testing-library'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import {
  createDesktopUpdateStore,
  desktopUpdatesEnabled,
  useDesktopUpdate,
  updateReducer,
  initialUpdateState,
  selectUpdateAction,
  type UpdateState,
  type UpdateStatus,
} from './use-desktop-update'

describe('updateReducer', () => {
  describe('CHECK_START', () => {
    it('should set status to checking and clear error', () => {
      const stateWithError: UpdateState = {
        ...initialUpdateState,
        status: 'error',
        error: 'Previous error',
        errorPhase: 'check',
      }

      const result = updateReducer(stateWithError, { type: 'CHECK_START' })

      expect(result.status).toBe('checking')
      expect(result.error).toBeNull()
    })
  })

  describe('CHECK_SUCCESS', () => {
    it('should set status to available when update exists', () => {
      const mockUpdate = { version: '1.0.0' } as UpdateState['update']
      const state: UpdateState = { ...initialUpdateState, status: 'checking' }

      const result = updateReducer(state, { type: 'CHECK_SUCCESS', update: mockUpdate })

      expect(result.status).toBe('available')
      expect(result.update).toBe(mockUpdate)
    })

    it('should set status to idle when no update available', () => {
      const state: UpdateState = { ...initialUpdateState, status: 'checking' }

      const result = updateReducer(state, { type: 'CHECK_SUCCESS', update: null })

      expect(result.status).toBe('idle')
      expect(result.update).toBeNull()
    })
  })

  describe('DOWNLOAD_START', () => {
    it('should set status to downloading and reset progress', () => {
      const state: UpdateState = {
        ...initialUpdateState,
        status: 'available',
        update: { version: '1.0.0' } as UpdateState['update'],
        downloadProgress: 50,
      }

      const result = updateReducer(state, { type: 'DOWNLOAD_START' })

      expect(result.status).toBe('downloading')
      expect(result.downloadProgress).toBe(0)
    })
  })

  describe('DOWNLOAD_PROGRESS', () => {
    it('should update download progress', () => {
      const state: UpdateState = { ...initialUpdateState, status: 'downloading' }

      const result = updateReducer(state, { type: 'DOWNLOAD_PROGRESS', progress: 75 })

      expect(result.downloadProgress).toBe(75)
      expect(result.status).toBe('downloading')
    })
  })

  describe('DOWNLOAD_SUCCESS', () => {
    it('should set status to ready and progress to 100', () => {
      const state: UpdateState = {
        ...initialUpdateState,
        status: 'downloading',
        downloadProgress: 99,
      }

      const result = updateReducer(state, { type: 'DOWNLOAD_SUCCESS' })

      expect(result.status).toBe('ready')
      expect(result.downloadProgress).toBe(100)
    })
  })

  describe('ERROR', () => {
    it('should set status to error with message', () => {
      const state: UpdateState = { ...initialUpdateState, status: 'downloading' }

      const result = updateReducer(state, { type: 'ERROR', error: 'Download failed', phase: 'download' })

      expect(result.status).toBe('error')
      expect(result.error).toBe('Download failed')
      expect(result.errorPhase).toBe('download')
    })

    it('should preserve other state when erroring', () => {
      const mockUpdate = { version: '1.0.0' } as UpdateState['update']
      const state: UpdateState = {
        ...initialUpdateState,
        status: 'downloading',
        update: mockUpdate,
        downloadProgress: 50,
      }

      const result = updateReducer(state, { type: 'ERROR', error: 'Network error', phase: 'download' })

      expect(result.update).toBe(mockUpdate)
      expect(result.downloadProgress).toBe(50)
    })
  })

  describe('state transitions', () => {
    it('should handle full update flow', () => {
      const mockUpdate = { version: '2.0.0' } as UpdateState['update']

      let state = initialUpdateState
      expect(state.status).toBe('initial')

      state = updateReducer(state, { type: 'CHECK_START' })
      expect(state.status).toBe('checking')

      state = updateReducer(state, { type: 'CHECK_SUCCESS', update: mockUpdate })
      expect(state.status).toBe('available')

      state = updateReducer(state, { type: 'DOWNLOAD_START' })
      expect(state.status).toBe('downloading')
      expect(state.downloadProgress).toBe(0)

      state = updateReducer(state, { type: 'DOWNLOAD_PROGRESS', progress: 50 })
      expect(state.downloadProgress).toBe(50)

      state = updateReducer(state, { type: 'DOWNLOAD_SUCCESS' })
      expect(state.status).toBe('ready')
      expect(state.downloadProgress).toBe(100)
    })

    it('should handle error recovery flow', () => {
      let state = updateReducer(initialUpdateState, { type: 'CHECK_START' })
      state = updateReducer(state, { type: 'ERROR', error: 'Network error', phase: 'check' })
      expect(state.status).toBe('error')
      expect(state.errorPhase).toBe('check')

      state = updateReducer(state, { type: 'CHECK_START' })
      expect(state.status).toBe('checking')
      expect(state.error).toBeNull()
      expect(state.errorPhase).toBeNull()
    })
  })
})

describe('selectUpdateAction', () => {
  const cases: Array<[UpdateStatus, 'download' | 'restart' | 'check']> = [
    ['available', 'download'],
    ['ready', 'restart'],
    ['initial', 'check'],
    ['idle', 'check'],
    ['checking', 'check'],
    ['downloading', 'check'],
    ['restarting', 'check'],
    ['error', 'check'],
  ]

  it.each(cases)('maps %s → %s', (status, expected) => {
    expect(selectUpdateAction(status)).toBe(expected)
  })
})

describe('update transition guards', () => {
  it('does not admit a duplicate download or let a check overwrite a completed install', () => {
    const available: UpdateState = {
      ...initialUpdateState,
      status: 'available',
      update: { version: '2' } as UpdateState['update'],
    }
    const downloading = updateReducer(available, { type: 'DOWNLOAD_START' })
    expect(updateReducer(downloading, { type: 'DOWNLOAD_START' })).toBe(downloading)
    const ready = updateReducer(downloading, { type: 'DOWNLOAD_SUCCESS' })
    expect(updateReducer(ready, { type: 'CHECK_SUCCESS', update: null })).toBe(ready)
    expect(updateReducer(ready, { type: 'DOWNLOAD_PROGRESS', progress: 1 })).toBe(ready)
    expect(updateReducer(ready, { type: 'DOWNLOAD_SUCCESS' })).toBe(ready)
    expect(updateReducer(ready, { type: 'ERROR', phase: 'download', error: 'late failure' })).toBe(ready)
  })

  it('retries the failed phase and keeps an installed update available for restart', () => {
    const ready: UpdateState = { ...initialUpdateState, status: 'ready' }
    const restarting = updateReducer(ready, { type: 'RESTART_START' })
    expect(updateReducer(restarting, { type: 'RESTART_START' })).toBe(restarting)
    const failed = updateReducer(restarting, { type: 'ERROR', phase: 'restart', error: 'failed' })
    expect(selectUpdateAction(failed.status, failed.errorPhase)).toBe('restart')
    expect(updateReducer(failed, { type: 'CHECK_START' })).toBe(failed)
    expect(selectUpdateAction('error', 'download')).toBe('download')
  })
})

describe('desktop update operations', () => {
  const setup = (enabled = true) => {
    const download = mock(
      async (_onEvent: Parameters<NonNullable<UpdateState['update']>['downloadAndInstall']>[0]) => {},
    )
    const update = {
      version: '2',
      downloadAndInstall: download,
      close: mock(async () => {}),
    } as unknown as NonNullable<UpdateState['update']>
    const services = {
      enabled,
      check: mock(async (): Promise<UpdateState['update']> => update),
      disconnect: mock(async () => {}),
      relaunch: mock(async () => {}),
    }
    const store = createDesktopUpdateStore(services)
    return { store, services, download, update }
  }

  it('drives check, download and restart through one primary action', async () => {
    const { store, services, download } = setup()
    const { primaryAction } = store.getState()
    await primaryAction()
    expect(store.getState().status).toBe('available')
    await primaryAction()
    expect(store.getState().status).toBe('ready')
    await primaryAction()
    expect(store.getState().status).toBe('restarting')
    expect(services.check).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledTimes(1)
    expect(services.disconnect).toHaveBeenCalledTimes(1)
    expect(services.relaunch).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('thunderbolt_post_update')).toBe('1')
  })

  it('never loads the updater on web and ignores premature download/restart', async () => {
    const { store, services, download } = setup(false)
    await store.getState().checkForUpdates()
    await store.getState().downloadAndInstall()
    await store.getState().restartApp()
    expect(store.getState().status).toBe('initial')
    expect(services.check).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(services.relaunch).not.toHaveBeenCalled()
  })

  it('admits one check and retries check failures', async () => {
    const { store, services, update } = setup()
    const pending = Promise.withResolvers<UpdateState['update']>()
    services.check.mockImplementationOnce(() => pending.promise)
    const first = store.getState().checkForUpdates()
    await store.getState().checkForUpdates()
    expect(services.check).toHaveBeenCalledTimes(1)
    pending.reject('offline')
    await first
    expect(store.getState()).toMatchObject({ status: 'error', error: 'offline', errorPhase: 'check' })
    await store.getState().primaryAction()
    expect(store.getState()).toMatchObject({ status: 'available', update })
    expect(services.check).toHaveBeenCalledTimes(2)
  })

  it('allows later checks after the server reports no update', async () => {
    const { store, services } = setup()
    services.check.mockResolvedValueOnce(null)
    await store.getState().primaryAction()
    expect(store.getState().status).toBe('idle')
    await store.getState().primaryAction()
    expect(store.getState().status).toBe('available')
  })

  it('retries downloads without rechecking and ignores progress from the failed attempt', async () => {
    const { store, services, download } = setup()
    const pending = Promise.withResolvers<void>()
    const retry = Promise.withResolvers<void>()
    download.mockImplementationOnce(() => pending.promise).mockImplementationOnce(() => retry.promise)
    await store.getState().checkForUpdates()
    const first = store.getState().downloadAndInstall()
    const firstProgress = download.mock.calls[0][0]!
    await store.getState().downloadAndInstall()
    await store.getState().checkForUpdates()
    expect(download).toHaveBeenCalledTimes(1)
    firstProgress({ event: 'Started', data: { contentLength: 100 } })
    firstProgress({ event: 'Progress', data: { chunkLength: 25 } })
    expect(store.getState().downloadProgress).toBe(25)
    pending.reject({ message: 'download failed' })
    await first
    const second = store.getState().primaryAction()
    const nextProgress = download.mock.calls[1][0]!
    firstProgress({ event: 'Finished' })
    expect(store.getState().downloadProgress).toBe(0)
    nextProgress({ event: 'Started', data: {} })
    nextProgress({ event: 'Progress', data: { chunkLength: 10 } })
    expect(store.getState().downloadProgress).toBe(0)
    nextProgress({ event: 'Started', data: { contentLength: 10 } })
    nextProgress({ event: 'Progress', data: { chunkLength: 20 } })
    expect(store.getState().downloadProgress).toBe(100)
    nextProgress({ event: 'Finished' })
    retry.resolve()
    await second
    nextProgress({ event: 'Progress', data: { chunkLength: 1 } })
    expect(store.getState()).toMatchObject({ status: 'ready', downloadProgress: 100 })
    expect(services.check).toHaveBeenCalledTimes(1)
  })

  it('deduplicates restart, tolerates disconnect failure, and retries a failed relaunch', async () => {
    const { store, services } = setup()
    const disconnect = Promise.withResolvers<void>()
    services.disconnect.mockImplementationOnce(() => disconnect.promise)
    services.relaunch.mockRejectedValueOnce(new Error('restart failed'))
    await store.getState().primaryAction()
    await store.getState().primaryAction()
    const first = store.getState().restartApp()
    await store.getState().restartApp()
    await store.getState().checkForUpdates()
    expect(services.disconnect).toHaveBeenCalledTimes(1)
    expect(services.relaunch).not.toHaveBeenCalled()
    disconnect.reject(new Error('disconnect failed'))
    await first
    expect(store.getState()).toMatchObject({ status: 'error', errorPhase: 'restart', error: 'restart failed' })
    expect(localStorage.getItem('thunderbolt_post_update')).toBeNull()
    await store.getState().primaryAction()
    expect(services.relaunch).toHaveBeenCalledTimes(2)
    expect(services.check).toHaveBeenCalledTimes(1)
    expect(store.getState().status).toBe('restarting')
  })

  it.each([undefined, {}, 42])('handles non-Error native failures: %p', async (error) => {
    const { store, services } = setup()
    services.check.mockRejectedValueOnce(error)
    await store.getState().primaryAction()
    expect(store.getState().error).toBe(error === 42 ? '42' : 'Failed to check for updates')
  })

  it('handles an unserializable native failure', async () => {
    const { store, services } = setup()
    const circular: { self?: unknown } = {}
    circular.self = circular
    services.check.mockRejectedValueOnce(circular)
    await store.getState().primaryAction()
    expect(store.getState().error).toBe('Failed to check for updates')
  })
})

describe('shared automatic update check', () => {
  const setup = (enabled = platform.isDesktop()) => {
    const check = mock(async (): Promise<UpdateState['update']> => null)
    const store = createDesktopUpdateStore({
      enabled,
      check,
      disconnect: async () => {},
      relaunch: async () => {},
    })
    return { store, check }
  }

  beforeEach(() => {
    spyOn(platform, 'isDesktop').mockReturnValue(true)
  })

  afterEach(() => mock.restore())

  it('cancels an early unmount and only checks once across mounted surfaces', async () => {
    const { store, check } = setup()
    const early = renderHook(() => useDesktopUpdate(store))
    early.unmount()
    await act(async () => {
      await getClock().tickAsync(5000)
    })
    expect(check).not.toHaveBeenCalled()
    const first = renderHook(() => useDesktopUpdate(store))
    const second = renderHook(() => useDesktopUpdate(store))
    await act(async () => {
      await getClock().tickAsync(5000)
    })
    expect(check).toHaveBeenCalledTimes(1)
    expect(first.result.current.status).toBe('idle')
    expect(second.result.current.status).toBe('idle')
    first.unmount()
    second.unmount()
    const later = renderHook(() => useDesktopUpdate(store))
    await act(async () => {
      await getClock().tickAsync(5000)
    })
    expect(check).toHaveBeenCalledTimes(1)
    later.unmount()
  })

  it('does not repeat a manual check when the automatic delay expires', async () => {
    const { store, check } = setup()
    const view = renderHook(() => useDesktopUpdate(store))
    await act(() => view.result.current.checkForUpdates())
    expect(check).toHaveBeenCalledTimes(1)
    await act(async () => {
      await getClock().tickAsync(5000)
    })
    expect(check).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('keeps automatic check failures visible across remounts until an explicit retry', async () => {
    const { store, check } = setup()
    check.mockRejectedValueOnce(new Error('offline'))
    const first = renderHook(() => useDesktopUpdate(store))
    await act(async () => {
      await getClock().tickAsync(5000)
    })
    expect(first.result.current).toMatchObject({ status: 'error', errorPhase: 'check', error: 'offline' })
    first.unmount()
    const later = renderHook(() => useDesktopUpdate(store))
    await act(async () => {
      await getClock().tickAsync(5000)
    })
    expect(check).toHaveBeenCalledTimes(1)
    expect(later.result.current.status).toBe('error')
    await act(() => later.result.current.primaryAction())
    expect(check).toHaveBeenCalledTimes(2)
    expect(later.result.current.status).toBe('idle')
    later.unmount()
  })

  it('does not schedule automatic checks on web', async () => {
    spyOn(platform, 'isDesktop').mockReturnValue(false)
    const { store, check } = setup()
    const view = renderHook(() => useDesktopUpdate(store))
    await act(async () => {
      await getClock().tickAsync(5000)
    })
    expect(check).not.toHaveBeenCalled()
    expect(view.result.current.status).toBe('initial')
    view.unmount()
  })

  it.each([
    { desktop: false, development: false, nativeDebug: false },
    { desktop: true, development: true, nativeDebug: false },
    { desktop: true, development: true, nativeDebug: true },
    { desktop: true, development: false, nativeDebug: true },
    { desktop: true, development: false, nativeDebug: false },
  ])('gates automatic and manual checks for %j', async (environment) => {
    const { store, check } = setup(desktopUpdatesEnabled(environment))
    const view = renderHook(() => useDesktopUpdate(store))
    await act(async () => getClock().tickAsync(5000))
    await act(async () => {
      await view.result.current.checkForUpdates()
      await view.result.current.primaryAction()
    })
    const releaseDesktop = environment.desktop && !environment.development && !environment.nativeDebug
    expect(check).toHaveBeenCalledTimes(releaseDesktop ? 3 : 0)
    expect(view.result.current).toMatchObject({
      enabled: releaseDesktop,
      status: releaseDesktop ? 'idle' : 'initial',
      error: null,
    })
    view.unmount()
  })
})

describe('updater manifest replacement', () => {
  it('closes a superseded native update after an explicit recheck', async () => {
    const old = { close: mock(async () => {}) } as unknown as NonNullable<UpdateState['update']>
    const check = mock(async (): Promise<UpdateState['update']> => old)
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(null)
    const store = createDesktopUpdateStore({
      enabled: true,
      check,
      disconnect: async () => {},
      relaunch: async () => {},
    })
    await store.getState().checkForUpdates()
    await store.getState().checkForUpdates()
    expect(store.getState()).toMatchObject({ status: 'idle', update: null })
    expect(old.close).toHaveBeenCalledTimes(1)
  })

  it('recovers from a withdrawn release and a failure to release the old native resource', async () => {
    const old = {
      downloadAndInstall: mock(async () => {
        throw new Error('asset withdrawn')
      }),
      close: mock(async () => {
        throw new Error('native cleanup failed')
      }),
    } as unknown as NonNullable<UpdateState['update']>
    const replacement = { downloadAndInstall: mock(async () => {}) } as unknown as NonNullable<UpdateState['update']>
    const check = mock(async (): Promise<UpdateState['update']> => old)
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(replacement)
    const store = createDesktopUpdateStore({
      enabled: true,
      check,
      disconnect: async () => {},
      relaunch: async () => {},
    })
    await store.getState().primaryAction()
    await store.getState().primaryAction()
    expect(store.getState()).toMatchObject({ status: 'error', errorPhase: 'download' })
    await store.getState().checkForUpdates()
    expect(store.getState()).toMatchObject({ status: 'available', update: replacement })
    expect(old.close).toHaveBeenCalledTimes(1)
    await store.getState().primaryAction()
    expect(store.getState().status).toBe('ready')
  })
})
