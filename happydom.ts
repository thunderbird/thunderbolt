import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

// Add comprehensive Node.js polyfills for better compatibility
import { ReadableStream, WritableStream, TransformStream } from 'stream/web'

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
