import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

// Add comprehensive Node.js polyfills for better compatibility
import { ReadableStream, TransformStream, WritableStream } from 'stream/web'

// Polyfill Web Streams API
globalThis.ReadableStream = ReadableStream
globalThis.WritableStream = WritableStream
globalThis.TransformStream = TransformStream

// Add other Node.js globals that might be needed
if (typeof globalThis.process === 'undefined') {
  globalThis.process = process
}

// Add Node.js Buffer if needed
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer
}

// Add jest global for @testing-library/react compatibility
// This must be set before @testing-library/react loads
// We use an object with getters so that @testing-library can capture a reference
// and it will still work when installFakeTimers updates the implementation
// @ts-ignore
const jestTimerImpl = {
  advanceTimersByTime: null as ((ms: number) => void) | null,
  runAllTimers: null as (() => void) | null,
  runOnlyPendingTimers: null as (() => void) | null,
  clearAllTimers: null as (() => void) | null,
  getTimerCount: null as (() => number) | null,
}

// @ts-ignore
globalThis.jest = {
  get advanceTimersByTime() {
    return jestTimerImpl.advanceTimersByTime || (() => {})
  },
  set advanceTimersByTime(fn) {
    jestTimerImpl.advanceTimersByTime = fn
  },
  get runAllTimers() {
    return jestTimerImpl.runAllTimers || (() => {})
  },
  set runAllTimers(fn) {
    jestTimerImpl.runAllTimers = fn
  },
  get runOnlyPendingTimers() {
    return jestTimerImpl.runOnlyPendingTimers || (() => {})
  },
  set runOnlyPendingTimers(fn) {
    jestTimerImpl.runOnlyPendingTimers = fn
  },
  get clearAllTimers() {
    return jestTimerImpl.clearAllTimers || (() => {})
  },
  set clearAllTimers(fn) {
    jestTimerImpl.clearAllTimers = fn
  },
  get getTimerCount() {
    return jestTimerImpl.getTimerCount || (() => 0)
  },
  set getTimerCount(fn) {
    jestTimerImpl.getTimerCount = fn
  },
}

// Export the implementation object so installFakeTimers can update it
// @ts-ignore
globalThis.__jestTimerImpl = jestTimerImpl
