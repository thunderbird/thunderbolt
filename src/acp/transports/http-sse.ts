/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * HTTP+SSE transport for ACP. Connected mode routes JSON-RPC requests through
 * the Universal Proxy via `getProxyFetch()`. Standalone Tauri uses the Rust
 * command (`src/lib/tauri-acp-http.ts`) so the request hits the upstream
 * directly via `reqwest` — the SSE response is streamed back over a
 * `tauri::ipc::Channel`.
 *
 * The transport adapts an HTTP+SSE conversation to the ACP SDK's `Stream`
 * (a pair of `ReadableStream`/`WritableStream<AnyMessage>` halves). Each
 * outbound write triggers a single POST that opens a streaming response;
 * inbound SSE chunks are parsed and emitted on the readable side. This
 * matches the long-poll-style ACP HTTP transport described in the spec.
 *
 * iOS URL validation: rejects `http://` upfront when running on Tauri iOS.
 */

import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import { getPlatform } from '@/lib/platform'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { AcpHttpEvent, AcpHttpHandle, AcpHttpSseRequestFn, AcpTransport } from '../types'

export type IsTauriIosFn = () => boolean

const defaultIsTauriIos: IsTauriIosFn = () => {
  if (typeof window === 'undefined' || !('isTauri' in window)) {
    return false
  }
  return getPlatform() === 'ios'
}

/** Reject `http://` upfront on Tauri iOS — ATS blocks cleartext requests. */
export const validateHttpUrl = (url: string, isTauriIos: IsTauriIosFn = defaultIsTauriIos): void => {
  if (!isTauriIos()) {
    return
  }
  if (url.toLowerCase().startsWith('http://')) {
    throw new Error(`Insecure HTTP URL not allowed on iOS: ${url}. Use https:// instead.`)
  }
}

/** Parse the buffer for complete `data: <line>\n\n` SSE frames, returning
 *  parsed JSON payloads and the trailing partial buffer. We ignore comment
 *  lines (`:` prefix) and `event:` lines — ACP framing is one JSON object per
 *  `data:` block. Malformed JSON throws; the caller decides whether to abort. */
export const parseSseFrames = (buffer: string): { messages: AnyMessage[]; remainder: string } => {
  const messages: AnyMessage[] = []
  let remainder = buffer
  for (;;) {
    const sep = remainder.indexOf('\n\n')
    if (sep === -1) {
      break
    }
    const frame = remainder.slice(0, sep)
    remainder = remainder.slice(sep + 2)
    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
    if (dataLines.length === 0) {
      continue
    }
    const data = dataLines.join('\n')
    if (data === '[DONE]') {
      continue
    }
    messages.push(JSON.parse(data) as AnyMessage)
  }
  return { messages, remainder }
}

export type HttpSseTransportOptions = {
  url: string
  signal: AbortSignal
  /** True when running in Tauri AND the cloud-proxy toggle is OFF (Standalone).
   *  Connected mode (web always; Tauri with toggle ON) uses `getProxyFetch`. */
  useTauriNative: boolean
  getProxyFetch: () => FetchFn
  /** Override for tests so the Tauri-native path can be exercised in jsdom. */
  acpHttpSseRequest?: AcpHttpSseRequestFn
  isTauriIos?: IsTauriIosFn
}

/** Open an HTTP+SSE transport. Each `write()` on the writable half POSTs the
 *  outbound message to `url`; the response body is parsed as SSE and routed
 *  to the readable half. The transport stays open across multiple JSON-RPC
 *  request/response pairs by serializing writes through a queue. */
export const openHttpSseTransport = async (options: HttpSseTransportOptions): Promise<AcpTransport> => {
  validateHttpUrl(options.url, options.isTauriIos)

  const transportController = new AbortController()
  if (options.signal.aborted) {
    transportController.abort()
  } else {
    options.signal.addEventListener('abort', () => transportController.abort(), { once: true })
  }

  let readableController: ReadableStreamDefaultController<AnyMessage> | null = null
  let activeHandle: AcpHttpHandle | null = null
  let connectedAbort: AbortController | null = null

  const dispatchMessages = (messages: AnyMessage[]): void => {
    if (!readableController) {
      return
    }
    for (const msg of messages) {
      readableController.enqueue(msg)
    }
  }

  const sendViaTauri = async (body: string): Promise<void> => {
    const acpHttpSseRequest = options.acpHttpSseRequest
    if (!acpHttpSseRequest) {
      throw new Error('Tauri ACP HTTP transport is unavailable: acpHttpSseRequest not provided')
    }
    let buffer = ''
    const handle = await acpHttpSseRequest(
      options.url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body,
      },
      (event: AcpHttpEvent) => {
        if (event.type === 'chunk') {
          buffer += event.data
          const { messages, remainder } = parseSseFrames(buffer)
          buffer = remainder
          dispatchMessages(messages)
          return
        }
        if (event.type === 'end') {
          if (buffer.length > 0) {
            const { messages } = parseSseFrames(`${buffer}\n\n`)
            dispatchMessages(messages)
            buffer = ''
          }
          return
        }
        if (event.type === 'error') {
          readableController?.error(new Error(event.message))
          transportController.abort()
        }
      },
    )
    activeHandle = handle
  }

  const sendViaProxy = async (body: string): Promise<void> => {
    connectedAbort = new AbortController()
    const onAbort = (): void => connectedAbort?.abort()
    transportController.signal.addEventListener('abort', onAbort, { once: true })

    const proxyFetch = options.getProxyFetch()
    const response = await proxyFetch(options.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body,
      signal: connectedAbort.signal,
    })

    if (!response.ok) {
      throw new Error(`ACP HTTP transport: upstream returned ${response.status}`)
    }
    if (!response.body) {
      throw new Error('ACP HTTP transport: empty response body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const { messages, remainder } = parseSseFrames(buffer)
      buffer = remainder
      dispatchMessages(messages)
    }
    if (buffer.length > 0) {
      const { messages } = parseSseFrames(`${buffer}\n\n`)
      dispatchMessages(messages)
    }
  }

  const send = (msg: AnyMessage): Promise<void> => {
    const body = JSON.stringify(msg)
    return options.useTauriNative ? sendViaTauri(body) : sendViaProxy(body)
  }

  const readable = new ReadableStream<AnyMessage>({
    start(c) {
      readableController = c
    },
  })

  const writable = new WritableStream<AnyMessage>({
    async write(msg) {
      await send(msg)
    },
    close() {
      activeHandle?.cancel()
      connectedAbort?.abort()
    },
    abort() {
      activeHandle?.cancel()
      connectedAbort?.abort()
    },
  })

  const stream: Stream = { readable, writable }

  const close = (): void => {
    transportController.abort()
    activeHandle?.cancel()
    connectedAbort?.abort()
    readableController?.close()
  }

  return { stream, close }
}
