/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import {
  applyWaitingUpdate,
  checkForServiceWorkerUpdate,
  registerServiceWorker,
  skipWaitingMessage,
  startUpdatePolling,
} from './service-worker'

/** Minimal stand-in for a ServiceWorker, with the state machine the update flow
 *  actually depends on: a `state` field and `statechange` listeners. */
const createWorker = (state: ServiceWorker['state'] = 'installing') => {
  const listeners: Array<() => void> = []
  return {
    state,
    postMessage: mock(() => {}),
    addEventListener: (event: string, handler: () => void) => {
      if (event === 'statechange') {
        listeners.push(handler)
      }
    },
    /** Drives the worker to a new state and notifies listeners, as the browser would. */
    transitionTo(next: ServiceWorker['state']) {
      this.state = next
      for (const handler of [...listeners]) {
        handler()
      }
    },
  }
}

const createRegistration = (workers: { waiting?: unknown; installing?: unknown } = {}) => {
  const listeners: Record<string, Array<() => void>> = {}
  return {
    waiting: workers.waiting ?? null,
    installing: workers.installing ?? null,
    update: mock(async () => {}),
    addEventListener: (event: string, handler: () => void) => {
      listeners[event] ??= []
      listeners[event].push(handler)
    },
    emit(event: string) {
      for (const handler of listeners[event] ?? []) {
        handler()
      }
    },
  }
}

const createContainer = (registration: unknown, controller: unknown = {}) => ({
  controller,
  register: mock(async () => registration),
})

describe('applyWaitingUpdate', () => {
  it('asks the waiting worker to skip waiting', () => {
    const waiting = createWorker('installed')
    const registration = createRegistration({ waiting })

    applyWaitingUpdate(registration as never, () => {})

    // The generated worker only calls skipWaiting() for this exact message.
    expect(waiting.postMessage).toHaveBeenCalledWith(skipWaitingMessage)
  })

  it('reloads once the new worker has activated, not before', () => {
    const waiting = createWorker('installed')
    const registration = createRegistration({ waiting })
    const reload = mock(() => {})

    applyWaitingUpdate(registration as never, reload)

    // Reloading while the worker is still 'installed' would land back on the old
    // bundle, since the waiting worker is not yet in control.
    expect(reload).not.toHaveBeenCalled()

    waiting.transitionTo('activating')
    expect(reload).not.toHaveBeenCalled()

    waiting.transitionTo('activated')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads immediately when the worker already activated', () => {
    // Another tab can promote the same waiting worker first, and a worker that
    // is already activated will never fire `statechange` again.
    const waiting = createWorker('activated')
    const registration = createRegistration({ waiting })
    const reload = mock(() => {})

    applyWaitingUpdate(registration as never, reload)

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does nothing when no worker is waiting', () => {
    const registration = createRegistration()
    const reload = mock(() => {})

    expect(() => applyWaitingUpdate(registration as never, reload)).not.toThrow()
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('registerServiceWorker', () => {
  it('reports a worker that was already waiting from an earlier visit', async () => {
    // No `updatefound` will ever fire for it, so registration has to look.
    const registration = createRegistration({ waiting: createWorker('installed') })
    const onUpdateReady = mock(() => {})

    await registerServiceWorker({ onUpdateReady, container: createContainer(registration) as never })

    expect(onUpdateReady).toHaveBeenCalledTimes(1)
  })

  it('reports an update once a newly installed worker finishes installing', async () => {
    const installing = createWorker('installing')
    const registration = createRegistration({ installing })
    const onUpdateReady = mock(() => {})

    await registerServiceWorker({ onUpdateReady, container: createContainer(registration) as never })
    registration.emit('updatefound')

    expect(onUpdateReady).not.toHaveBeenCalled()

    installing.transitionTo('installed')
    expect(onUpdateReady).toHaveBeenCalledTimes(1)
  })

  it('stays quiet on the very first install', async () => {
    // With no existing controller there is no previous bundle to replace, so
    // prompting would ask the user to reload into what they already run.
    const installing = createWorker('installing')
    const registration = createRegistration({ installing })
    const onUpdateReady = mock(() => {})

    await registerServiceWorker({
      onUpdateReady,
      container: createContainer(registration, null) as never,
    })
    registration.emit('updatefound')
    installing.transitionTo('installed')

    expect(onUpdateReady).not.toHaveBeenCalled()
  })

  it('resolves undefined instead of throwing when registration fails', async () => {
    // Private browsing, an unsupported browser, or a 404 on /sw.js must not stop
    // the app from booting.
    const container = { controller: null, register: mock(async () => Promise.reject(new Error('nope'))) }

    const result = await registerServiceWorker({ onUpdateReady: () => {}, container: container as never })

    expect(result).toBeUndefined()
  })
})

describe('checkForServiceWorkerUpdate', () => {
  it('reports false when the browser rejects the check', async () => {
    const registration = { update: mock(async () => Promise.reject(new Error('offline'))) }
    expect(await checkForServiceWorkerUpdate(registration as never)).toBe(false)
  })

  it('reports true when the check runs', async () => {
    const registration = createRegistration()
    expect(await checkForServiceWorkerUpdate(registration as never)).toBe(true)
    expect(registration.update).toHaveBeenCalledTimes(1)
  })
})

describe('startUpdatePolling', () => {
  it('checks again when the app returns to the foreground', () => {
    // The case that matters for an installed app: phones resume rather than
    // relaunch, so without this a home screen app could run a stale bundle for
    // days between cold starts.
    const registration = createRegistration()
    let clock = 0
    const teardown = startUpdatePolling(registration as never, {
      throttleMs: 1000,
      now: () => clock,
    })

    clock = 5000
    document.dispatchEvent(new Event('visibilitychange'))

    expect(registration.update).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('throttles rapid foregrounding into a single check', () => {
    const registration = createRegistration()
    let clock = 0
    const teardown = startUpdatePolling(registration as never, {
      throttleMs: 1000,
      now: () => clock,
    })

    clock = 5000
    document.dispatchEvent(new Event('visibilitychange'))
    clock = 5100
    document.dispatchEvent(new Event('visibilitychange'))
    clock = 5200
    document.dispatchEvent(new Event('visibilitychange'))

    expect(registration.update).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('stops checking after teardown', () => {
    const registration = createRegistration()
    let clock = 0
    const teardown = startUpdatePolling(registration as never, {
      throttleMs: 1000,
      now: () => clock,
    })

    teardown()

    clock = 5000
    document.dispatchEvent(new Event('visibilitychange'))

    expect(registration.update).not.toHaveBeenCalled()
  })
})
