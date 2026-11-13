/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type AbortSignalConstructorCompat = typeof AbortSignal & {
  abort?: (reason?: unknown) => AbortSignal
  any?: (signals: Iterable<AbortSignal>) => AbortSignal
  timeout?: (milliseconds: number) => AbortSignal
}

type AbortControllerConstructorCompat = typeof AbortController & {
  prototype: AbortController & { abort: (reason?: unknown) => void }
}

type AbortRuntime = Pick<typeof globalThis, 'AbortController' | 'AbortSignal' | 'setTimeout'>

const makeAbortReason = (name: string, message: string): Error => {
  if (typeof DOMException !== 'undefined') return new DOMException(message, name)
  const error = new Error(message)
  error.name = name
  return error
}

/** Adds the AbortSignal methods used by Pi and Thunderbolt to legacy runtimes. */
export const installAbortSignalCompatibility = (runtime: AbortRuntime): void => {
  const signalConstructor = runtime.AbortSignal as AbortSignalConstructorCompat
  const controllerConstructor = runtime.AbortController as AbortControllerConstructorCompat
  const reasons = new WeakMap<AbortSignal, unknown>()
  const signalPrototype = signalConstructor.prototype as AbortSignal & {
    reason?: unknown
    throwIfAborted?: () => void
  }
  const hasNativeReason = 'reason' in signalPrototype

  if (!hasNativeReason) {
    Object.defineProperty(signalPrototype, 'reason', {
      configurable: true,
      get(this: AbortSignal): unknown {
        if (!this.aborted) return undefined
        return reasons.has(this) ? reasons.get(this) : makeAbortReason('AbortError', 'The operation was aborted')
      },
    })
  }

  signalPrototype.throwIfAborted ??= function (this: AbortSignal): void {
    if (this.aborted) {
      const reason = this.reason
      throw reason === undefined ? makeAbortReason('AbortError', 'The operation was aborted') : reason
    }
  }

  if (!signalConstructor.abort) {
    signalConstructor.abort = (reason?: unknown): AbortSignal => {
      const controller = new controllerConstructor()
      controller.abort(reason)
      return controller.signal
    }
  }

  if (!signalConstructor.any) {
    signalConstructor.any = (input: Iterable<AbortSignal>): AbortSignal => {
      const signals = Array.from(input)
      for (const signal of signals) {
        if (signal.aborted) return signalConstructor.abort?.(signal.reason) as AbortSignal
      }

      const controller = new controllerConstructor()
      const listeners = new Map<AbortSignal, () => void>()
      const cleanup = (): void => {
        for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
        listeners.clear()
      }
      for (const signal of signals) {
        const listener = (): void => {
          if (!controller.signal.aborted) controller.abort(signal.reason)
          cleanup()
        }
        listeners.set(signal, listener)
        signal.addEventListener('abort', listener, { once: true })
      }
      if (controller.signal.aborted) cleanup()
      return controller.signal
    }
  }

  if (!signalConstructor.timeout) {
    signalConstructor.timeout = (milliseconds: number): AbortSignal => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new RangeError('The timeout must be a non-negative finite number')
      }
      const controller = new controllerConstructor()
      runtime.setTimeout(() => {
        controller.abort(makeAbortReason('TimeoutError', 'The operation timed out'))
      }, Math.min(Math.trunc(milliseconds), 2_147_483_647))
      return controller.signal
    }
  }

  if (hasNativeReason) return
  const controllerPrototype = controllerConstructor.prototype
  const originalAbort = controllerPrototype.abort
  controllerPrototype.abort = function (reason?: unknown): void {
    if (!this.signal.aborted) {
      reasons.set(this.signal, reason === undefined ? makeAbortReason('AbortError', 'The operation was aborted') : reason)
    }
    originalAbort.call(this)
  }
}
