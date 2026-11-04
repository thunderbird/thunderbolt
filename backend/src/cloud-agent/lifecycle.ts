/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CloudRuntime } from './runtime'
import type { PostgresRuntimeStore } from './storage'
import type { createCloudScheduler } from './scheduler'

type Scheduler = ReturnType<typeof createCloudScheduler>
type LifecycleOptions = {
  openStore: (onFatal: (error: Error) => void) => Promise<PostgresRuntimeStore>
  createRuntime: (store: PostgresRuntimeStore) => CloudRuntime
  createScheduler: (runtime: CloudRuntime) => Scheduler
  collectGarbage: () => Promise<unknown>
  onFatal: (error: Error) => void
  reportError: (code: string) => void
}

/** Own initialization and cleanup together so an early ownership failure cannot escape shutdown. */
export const startCloudAgentLifecycle = async (options: LifecycleOptions) => {
  const state: {
    initializing: boolean
    failure?: Error
    store?: PostgresRuntimeStore
    runtime?: CloudRuntime
    scheduler?: Scheduler
    garbageTimer?: ReturnType<typeof setInterval>
    garbageTask?: Promise<void>
    closePromise?: Promise<void>
  } = { initializing: true }
  const stopAdmissions = () => {
    state.scheduler?.stop()
    clearInterval(state.garbageTimer)
  }
  const cleanup = async () => {
    stopAdmissions()
    try {
      await state.runtime?.close()
    } finally {
      // Runtime construction/closure can fail before it releases its store.
      try {
        await state.store?.close()
      } finally {
        await state.scheduler?.drain()
        await state.garbageTask
      }
    }
  }
  const close = () => (state.closePromise ??= cleanup())
  const fatal = (error: Error) => {
    if (state.failure) {
      return
    }
    state.failure = error
    options.onFatal(error)
    stopAdmissions()
    // While openStore is resolving, cleanup must wait until the returned resource has been assigned.
    if (!state.initializing) {
      void close().catch(() => options.reportError('cloud_runtime_shutdown_failed'))
    }
  }
  try {
    state.store = await options.openStore(fatal)
    if (state.failure) {
      throw state.failure
    }
    state.runtime = options.createRuntime(state.store)
    state.scheduler = options.createScheduler(state.runtime)
    await state.scheduler.tick()
    if (state.failure) {
      throw state.failure
    }
    state.garbageTimer = setInterval(() => {
      if (state.garbageTask) {
        return
      }
      const collect = async () => {
        try {
          await options.collectGarbage()
        } catch {
          options.reportError('artifact_cleanup_failed')
        } finally {
          state.garbageTask = undefined
        }
      }
      state.garbageTask = collect()
    }, 60_000)
    state.initializing = false
    return { close }
  } catch (error) {
    state.initializing = false
    try {
      await close()
    } catch {
      options.reportError('cloud_runtime_shutdown_failed')
    }
    throw error
  }
}
