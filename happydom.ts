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

// Set up jest global with fake timer support IMMEDIATELY
// This MUST be set up before @testing-library loads to avoid race conditions
import { install } from '@sinonjs/fake-timers'

console.log('[happydom.ts] Installing fake timers...')

// Install fake timers globally at module load time
// This ensures they're always available when @testing-library checks for them
// Note: We don't fake requestAnimationFrame because happy-dom hasn't fully initialized yet
const globalClock = install({
  now: Date.now(),
  shouldAdvanceTime: false,
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
})

console.log('[happydom.ts] Fake timers installed, setting up jest global...')

// Set up jest global with methods connected to the global clock
const jestApi = {
  advanceTimersByTime: (ms: number) => {
    console.log(`[jest.advanceTimersByTime] Called with ${ms}ms`)
    return globalClock.tick(ms)
  },
  runAllTimers: () => globalClock.runAll(),
  runOnlyPendingTimers: () => globalClock.runToLast(),
  clearAllTimers: () => globalClock.reset(),
  getTimerCount: () => globalClock.countTimers(),
}

// @ts-ignore - Set on globalThis
globalThis.jest = jestApi
// @ts-ignore - Also set on global for compatibility
if (typeof global !== 'undefined') {
  // @ts-ignore
  global.jest = jestApi
}

console.log('[happydom.ts] jest global set up:', {
  hasGlobalThisJest: !!globalThis.jest,
  hasGlobalJest: typeof global !== 'undefined' && !!(global as any).jest,
  advanceTimersByTimeType: typeof globalThis.jest?.advanceTimersByTime,
})

// Export the clock so testing-library.ts can access it
// @ts-ignore
globalThis.__GLOBAL_FAKE_CLOCK__ = globalClock

console.log('[happydom.ts] Setup complete')
