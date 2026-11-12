/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Buffer } from 'buffer'
import TextDecoderStream from 'text-decoder'
import structuredClonePolyfill from '@ungap/structured-clone'
import AbortControllerPolyfill, { AbortSignal as AbortSignalPolyfill } from 'abort-controller/dist/abort-controller.js'
import { URL as RuntimeURL, URLSearchParams as RuntimeURLSearchParams } from 'whatwg-url'
import BlobPolyfill from 'fetch-blob'
import { FormData as FormDataPolyfill } from 'formdata-polyfill/esm.min.js'
import { installAbortSignalCompatibility } from './abort-signal-compat'
import {
  ReadableStream as PonyfillReadableStream,
  TransformStream as PonyfillTransformStream,
  WritableStream as PonyfillWritableStream,
} from 'web-streams-polyfill/ponyfill/es2018'

type NativeRuntimeGlobals = typeof globalThis & {
  __thunderboltNative?: {
    randomBytes: (size: number) => string
    randomUUID: () => string
    scheduleTimer: (id: string, delay: number, callback: () => void) => void
    cancelTimer: (id: string) => void
  }
}

const scope = globalThis as NativeRuntimeGlobals
const native = scope.__thunderboltNative
if (!native) throw new Error('The native JavaScript bridge must be installed before the Pi runtime bundle')

scope.ReadableStream ??= PonyfillReadableStream
scope.WritableStream ??= PonyfillWritableStream
scope.TransformStream ??= PonyfillTransformStream
scope.AbortController ??= AbortControllerPolyfill as unknown as typeof AbortController
scope.AbortSignal ??= AbortSignalPolyfill as unknown as typeof AbortSignal
installAbortSignalCompatibility(scope)
scope.URL ??= RuntimeURL as unknown as typeof URL
scope.URLSearchParams ??= RuntimeURLSearchParams as unknown as typeof URLSearchParams
scope.Blob ??= BlobPolyfill as unknown as typeof Blob
scope.FormData ??= FormDataPolyfill as unknown as typeof FormData
scope.structuredClone ??= structuredClonePolyfill as typeof structuredClone

class RuntimeTextEncoder {
  encode(input = ''): Uint8Array { return Uint8Array.from(Buffer.from(input, 'utf8')) }
}

class RuntimeTextDecoder {
  private readonly decoder = new TextDecoderStream('utf8')

  decode(input?: AllowSharedBufferSource, options?: { stream?: boolean }): string {
    const bytes = input ? new Uint8Array(input as ArrayBuffer) : undefined
    return options?.stream ? this.decoder.push(bytes ?? new Uint8Array()) : this.decoder.end(bytes)
  }
}

scope.TextEncoder ??= RuntimeTextEncoder as unknown as typeof TextEncoder
scope.TextDecoder ??= RuntimeTextDecoder as unknown as typeof TextDecoder
scope.crypto ??= {
  randomUUID: () => native.randomUUID(),
  getRandomValues<T extends ArrayBufferView>(target: T): T {
    const bytes = Buffer.from(native.randomBytes(target.byteLength), 'base64')
    if (bytes.byteLength !== target.byteLength) throw new Error('Secure random bytes are unavailable')
    new Uint8Array(target.buffer, target.byteOffset, target.byteLength).set(bytes)
    return target
  },
}
scope.setTimeout ??= ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
  const id = native.randomUUID()
  native.scheduleTimer(id, Math.max(0, delay), () => callback(...args))
  return id as unknown as number
}) as typeof setTimeout
scope.clearTimeout ??= ((id: string | number) => native.cancelTimer(String(id))) as typeof clearTimeout
const intervals = new Map<string, string>()
scope.setInterval ??= ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
  const handle = native.randomUUID()
  const schedule = (): void => {
    const timer = native.randomUUID()
    intervals.set(handle, timer)
    native.scheduleTimer(timer, Math.max(0, delay), () => {
      if (!intervals.has(handle)) return
      callback(...args)
      if (intervals.has(handle)) schedule()
    })
  }
  schedule()
  return handle as unknown as number
}) as typeof setInterval
scope.clearInterval ??= ((handle: string | number) => {
  const key = String(handle)
  const timer = intervals.get(key)
  if (timer) native.cancelTimer(timer)
  intervals.delete(key)
}) as typeof clearInterval
scope.setImmediate ??= ((callback: (...args: unknown[]) => void, ...args: unknown[]) =>
  scope.setTimeout(callback, 0, ...args)) as typeof setImmediate
scope.clearImmediate ??= ((id: string | number) => native.cancelTimer(String(id))) as typeof clearImmediate
scope.atob ??= ((value: string) => Buffer.from(value, 'base64').toString('binary'))
scope.btoa ??= ((value: string) => Buffer.from(value, 'binary').toString('base64'))
