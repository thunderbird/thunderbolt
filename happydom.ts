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

// Set up jest global IMMEDIATELY so @testing-library/react can detect fake timers
// This must be set up before any test code runs to avoid race conditions in CI
// The actual implementations will be set in testing-library.ts
// Set on both globalThis and global for maximum compatibility
const jestApi = {
  advanceTimersByTime: (ms: number) => {
    // This will be replaced by the real implementation in installFakeTimers
    console.warn('jest.advanceTimersByTime called before fake timers initialized')
  },
  runAllTimers: () => {
    console.warn('jest.runAllTimers called before fake timers initialized')
  },
  runOnlyPendingTimers: () => {
    console.warn('jest.runOnlyPendingTimers called before fake timers initialized')
  },
  clearAllTimers: () => {
    console.warn('jest.clearAllTimers called before fake timers initialized')
  },
  getTimerCount: () => 0,
}

// @ts-ignore
globalThis.jest = jestApi
// @ts-ignore
global.jest = jestApi
