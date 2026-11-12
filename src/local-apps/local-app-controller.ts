/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke } from '@tauri-apps/api/core'
import type { LocalApp, LocalAppLaunch, LocalAppOwner, LocalAppStatus } from '@shared/local-app-protocol'
import { isTauriDesktop } from '@/lib/platform'
import { createSerialQueue } from '@/lib/serial-queue'
import { isCurrentSshConnection, useSshEnvironmentsStore } from '@/agent-execution/ssh-environments'
import { getLocalApp, listLocalApps, useLocalAppStore } from './local-app-store'

type NativeInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>
type LocalAppInput = {
  owner: LocalAppOwner
  title: string
  cwd: string
  launch: LocalAppLaunch
  connection?: LocalApp['connection']
}
type LocalAppLaunchChanges = { executable?: string; args?: string[]; port?: number | null }

/** Validate a recipe before changing the currently running process. */
const validateLaunch = (launch: LocalAppLaunch) => {
  if (launch.mode !== 'attach' && !launch.executable.trim()) {
    throw new Error('A local app needs an executable')
  }
  if (launch.port !== undefined && (!Number.isInteger(launch.port) || launch.port < 1 || launch.port > 65535)) {
    throw new Error('The preview port must be between 1 and 65535')
  }
}

const delay = (signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, 150)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
    }
  })

/** Shared page tools and controls use the same local-app lifecycle. */
export const createLocalAppController = (native: NativeInvoke = invoke, supported = isTauriDesktop) => {
  const listeners = new Set<(status: LocalAppStatus) => void>()
  const invalidConnections = new Set<string>()
  type Startup = { abort: AbortController; promise: Promise<LocalAppStatus>; waiters: Set<symbol>; settled: boolean }
  const startups = new Map<string, Startup>()
  const operations = new Map<string, ReturnType<typeof createSerialQueue>>()
  const queueFor = (id: string) => {
    const existing = operations.get(id)
    if (existing) {
      return existing
    }
    const queue = createSerialQueue()
    operations.set(id, queue)
    return queue
  }
  const publish = (value: LocalAppStatus) => {
    for (const listener of listeners) {
      listener(value)
    }
    return value
  }
  const requireDesktop = () => {
    if (!supported()) {
      throw new Error('Local apps can only run in the desktop app')
    }
  }
  const requireApp = (id: string) => {
    requireDesktop()
    const app = getLocalApp(id)
    if (!app) {
      throw new Error('This local app is not available on this device')
    }
    return app
  }
  const stopped = (id: string): LocalAppStatus => ({ id, status: 'stopped', url: null, error: null, logs: '' })
  const status = async (id: string): Promise<LocalAppStatus> => {
    const app = requireApp(id)
    const value = (await native<LocalAppStatus | null>('agent_preview_status', { id })) ?? stopped(id)
    requireCurrentConnection(app)
    return publish(value)
  }
  const nativeStop = async (id: string) => {
    return publish((await native<LocalAppStatus | null>('agent_preview_stop', { id })) ?? stopped(id))
  }
  const stop = async (id: string): Promise<LocalAppStatus> => {
    requireApp(id)
    const startup = startups.get(id)
    if (startup) {
      startup.abort.abort()
      await startup.promise.catch(() => {})
    }
    return nativeStop(id)
  }
  const requireCurrentConnection = (app: LocalApp) => {
    if (app.connection && !isCurrentSshConnection(app.connection)) {
      throw new Error('The SSH environment changed or was removed. Create a new app in its current environment.')
    }
  }
  const launch = async (app: LocalApp, signal: AbortSignal): Promise<LocalAppStatus> => {
    requireCurrentConnection(app)
    invalidConnections.delete(app.id)
    const previous = await status(app.id)
    signal.throwIfAborted()
    requireCurrentConnection(app)
    if (previous.status === 'ready') {
      if (app.connection) {
        useSshEnvironmentsStore.getState().recordConnectionStatus(app.connection, 'connected')
      }
      return previous
    }
    const cancel = () => {
      void nativeStop(app.id).catch(console.error)
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const initial = await native<LocalAppStatus>('agent_preview_start', {
        request: {
          id: app.id,
          cwd: app.cwd,
          ...app.launch,
          ...(app.connection ? { connection: app.connection } : {}),
        },
      })
      signal.throwIfAborted()
      requireCurrentConnection(app)
      publish(initial)
      // SSH has a native two-minute setup deadline; allow time to report its result.
      const deadline = Date.now() + (app.connection ? 125_000 : 35_000)
      let current = initial
      while (current.status === 'starting') {
        signal.throwIfAborted()
        if (Date.now() > deadline) {
          throw new Error('Timed out waiting for the local app to start')
        }
        await delay(signal)
        current = await status(app.id)
      }
      signal.throwIfAborted()
      requireCurrentConnection(app)
      if (current.status !== 'ready' || !current.url) {
        throw new Error(current.error ?? 'The local app stopped before it was ready')
      }
      if (app.connection) {
        useSshEnvironmentsStore.getState().recordConnectionStatus(app.connection, 'connected')
      }
      return current
    } catch (error) {
      if (previous.status !== 'starting') {
        await nativeStop(app.id)
      }
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
  const start = async (id: string, signal?: AbortSignal): Promise<LocalAppStatus> => {
    const app = requireApp(id)
    signal?.throwIfAborted()
    let startup = startups.get(id)
    if (!startup || startup.abort.signal.aborted) {
      const abort = new AbortController()
      const next: Startup = { abort, promise: Promise.resolve(stopped(id)), waiters: new Set(), settled: false }
      const previous = startup?.promise.catch(() => {})
      next.promise = Promise.resolve(previous)
        .then(() => launch(app, abort.signal))
        .finally(() => {
          next.settled = true
          if (startups.get(id) === next) {
            startups.delete(id)
          }
        })
      startups.set(id, next)
      startup = next
    }
    const shared = startup
    const waiter = Symbol()
    shared.waiters.add(waiter)
    return new Promise<LocalAppStatus>((resolve, reject) => {
      const release = () => {
        signal?.removeEventListener('abort', onAbort)
        shared.waiters.delete(waiter)
        // React StrictMode reattaches its effect synchronously. Give that next
        // subscriber a chance to keep the shared startup before cancelling it.
        queueMicrotask(() => {
          if (!shared.settled && shared.waiters.size === 0) {
            shared.abort.abort()
          }
        })
      }
      const onAbort = () => {
        release()
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      shared.promise.then(
        (value) => {
          release()
          resolve(value)
        },
        (error) => {
          release()
          reject(error)
        },
      )
      if (signal?.aborted) {
        onAbort()
      }
    })
  }
  const stopInvalidSshPreviews = async () => {
    const invalid = Object.values(useLocalAppStore.getState().apps).filter(
      (app) =>
        !app.deletedAt && app.connection && !isCurrentSshConnection(app.connection) && !invalidConnections.has(app.id),
    )
    await Promise.all(
      invalid.map(async (app) => {
        invalidConnections.add(app.id)
        try {
          await queueFor(app.id)(async () => {
            await stop(app.id)
            publish({
              ...stopped(app.id),
              status: 'failed',
              error: 'The SSH environment changed or was removed. Create a new app in its current environment.',
            })
          })
        } catch (error) {
          invalidConnections.delete(app.id)
          throw error
        }
      }),
    )
  }
  // Serialize recipe changes and process admission, not HTTP readiness: Stop must
  // remain able to cancel a shared startup while it waits for the server.
  const launchInOrder = async (id: string, signal?: AbortSignal, prepare?: () => Promise<void>) => {
    const { pending } = await queueFor(id)(async () => {
      signal?.throwIfAborted()
      await prepare?.()
      signal?.throwIfAborted()
      return { pending: start(id, signal) }
    })
    return pending
  }
  return {
    stopInvalidSshPreviews,
    subscribe: (listener: (status: LocalAppStatus) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    list: listLocalApps,
    get: getLocalApp,
    create: ({ owner, title, cwd, launch, connection }: LocalAppInput): LocalApp => {
      requireDesktop()
      if (!owner.id || !cwd || !title.trim()) {
        throw new Error('A local app needs an owner, title, working directory, and executable')
      }
      validateLaunch(launch)
      if (launch.mode === 'attach' && !connection) {
        throw new Error('Attaching an existing service requires an SSH environment')
      }
      if (connection && !isCurrentSshConnection(connection)) {
        throw new Error('The SSH environment changed or was removed')
      }
      const app: LocalApp = {
        id: crypto.randomUUID(),
        owner,
        title: title.trim(),
        cwd,
        launch,
        ...(connection ? { connection } : {}),
        createdAt: new Date().toISOString(),
      }
      useLocalAppStore.getState().save(app)
      return app
    },
    start: (id: string, signal?: AbortSignal) => launchInOrder(id, signal),
    status,
    stop: (id: string) => queueFor(id)(() => stop(id)),
    restart: (id: string, signal?: AbortSignal) =>
      launchInOrder(id, signal, async () => {
        await stop(id)
      }),
    /** Replace only launch fields and restart under the same app/page identity. */
    update: (id: string, changes: LocalAppLaunchChanges, signal?: AbortSignal) =>
      launchInOrder(id, signal, async () => {
        const app = requireApp(id)
        if (app.connection && !isCurrentSshConnection(app.connection)) {
          throw new Error('The SSH environment changed or was removed')
        }
        if (changes.executable === undefined && changes.args === undefined && changes.port === undefined) {
          throw new Error('Provide executable, args, or port for update')
        }
        if (
          app.launch.mode === 'attach' &&
          (changes.executable !== undefined || changes.args !== undefined || changes.port === null)
        ) {
          throw new Error('An attached service can only change its remote port')
        }
        const launch: LocalAppLaunch =
          app.launch.mode === 'attach'
            ? { mode: 'attach', port: changes.port ?? app.launch.port }
            : {
                executable: changes.executable ?? app.launch.executable,
                args: changes.args ?? app.launch.args,
                port: changes.port === null ? undefined : (changes.port ?? app.launch.port),
              }
        validateLaunch(launch)
        await stop(id)
        signal?.throwIfAborted()
        useLocalAppStore.getState().save({ ...app, launch })
      }),
    remove: (id: string) =>
      queueFor(id)(async () => {
        await stop(id)
        useLocalAppStore.getState().remove(id)
      }),
  }
}

export const localAppController = createLocalAppController()

// Native previews can outlive a frontend reload, including tabs not reopened yet.
const stopInvalidSshPreviews = () => {
  if (isTauriDesktop()) {
    void localAppController.stopInvalidSshPreviews().catch(console.error)
  }
}
const unsubscribeSshProfiles = useSshEnvironmentsStore.subscribe((state, previous) => {
  if (state.environments !== previous.environments) {
    stopInvalidSshPreviews()
  }
})
stopInvalidSshPreviews()
import.meta.hot?.dispose(unsubscribeSshProfiles)
