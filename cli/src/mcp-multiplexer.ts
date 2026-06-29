// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The MCP multiplexer: fans many per-request StreamableHTTP transports onto the
// ONE stdio child. It owns the child's initialize cache, the process-global
// request-id remap, and the live-transport registry. The HTTP face owns binding,
// security, and teardown; this owns everything between a client message
// (transport.onmessage) and the child, and between the child's stdout and the
// owning transport (transport.send).
//
// Why a multiplexer at all: a StreamableHTTPServerTransport is single-session and
// rejects a second `initialize` POST with -32600 before onmessage fires, so a
// shared transport kills every connection after the first. We give each HTTP
// request its own STATELESS transport (the SDK forbids reusing one across
// requests) and reconcile their many initialize/id streams onto the single child
// here.

import { classifyFrame } from './log'
import { wsToFrame } from './relay'
import type { JsonRpcId, JsonRpcMessage, McpTransport, Multiplexer, MultiplexerOptions } from './types'

/** A client id paired with the transport that owns it (pending route / init waiter). */
type Route = { transport: McpTransport; clientId: JsonRpcId | null | undefined }

/** Build the multiplexer. */
const createMultiplexer = ({ writeChild, logger }: MultiplexerOptions): Multiplexer => {
  /** Live per-request transports, for broadcast + teardown. */
  const transports = new Set<McpTransport>()

  /**
   * Outstanding child requests keyed by the process-global id we assigned. Maps
   * back to the owning transport and the client's original id so the child's
   * response routes home with the id the client expects.
   */
  const pending = new Map<JsonRpcId, Route>()

  /** Monotonic counter backing the process-global request ids. */
  let seq = 0
  /** Prefix-tagged global id; the `b:` namespace can never collide with a client id. */
  const nextGlobalId = (): string => `b:${seq++}`

  /**
   * The child's negotiated initialize result (capabilities/serverInfo/
   * protocolVersion), captured from the first initialize response. Null until the
   * child has answered. Every later client initialize is answered from this.
   */
  let childInitResult: unknown = null
  /** True once the first initialize has been forwarded to the child. */
  let initForwarded = false
  /** True once `notifications/initialized` has been forwarded once. */
  let initializedNotified = false
  /** The global id under which the first initialize was forwarded to the child. */
  let initGlobalId: string | null = null
  /**
   * Initialize requests that arrived before the child answered the first one.
   * Each is answered from the cached result the moment it lands — never forwarded.
   */
  const initWaiters: Route[] = []

  /** Send one frame to a transport, swallowing a benign disconnected-client reject. */
  const sendTo = (transport: McpTransport, message: JsonRpcMessage): void => {
    Promise.resolve(transport.send(message)).catch(() => logger.warn('drop-child-frame', classifyFrame(message)))
  }

  /** Forward one client message to the child as NDJSON, dropping unserializable frames. */
  const forwardToChild = (message: JsonRpcMessage): void => {
    try {
      writeChild(wsToFrame(JSON.stringify(message)))
    } catch {
      logger.warn('drop-http-frame', classifyFrame(message))
    }
  }

  /**
   * Answer a client initialize from the cached child result, re-stamped with the
   * client's request id (the negotiated protocolVersion/capabilities are reused
   * verbatim from the child's reply).
   */
  const answerInitFromCache = (transport: McpTransport, clientId: JsonRpcId | null | undefined): void => {
    sendTo(transport, { jsonrpc: '2.0', id: clientId, result: childInitResult })
  }

  /**
   * Handle a client `initialize`. The first one is forwarded to the child under a
   * global id and the requester is queued; concurrent ones that arrive before the
   * child answers are queued too (never forwarded); once cached, every initialize
   * is answered directly. The child therefore sees exactly one initialize, ever.
   */
  const handleInitialize = (transport: McpTransport, message: JsonRpcMessage): void => {
    if (childInitResult !== null) {
      answerInitFromCache(transport, message.id)
      return
    }
    initWaiters.push({ transport, clientId: message.id })
    if (initForwarded) return // a forward is already in flight; just wait for it
    initForwarded = true
    initGlobalId = nextGlobalId()
    forwardToChild({ ...message, id: initGlobalId })
  }

  /**
   * Route the child's reply to the forwarded initialize. A success caches the
   * result and answers every queued waiter (the first plus any that raced in
   * behind it). An error is relayed to every waiter (re-stamped with their client
   * id) and the init state is RESET so the next client initialize re-forwards to
   * the child — otherwise a single child-side init failure would wedge every
   * future connection. Returns true when the message was the awaited initialize
   * reply.
   */
  const captureInitReply = (message: JsonRpcMessage): boolean => {
    if (childInitResult !== null || initGlobalId === null || message.id !== initGlobalId) return false
    if (message.result) {
      childInitResult = message.result
      for (const waiter of initWaiters.splice(0)) answerInitFromCache(waiter.transport, waiter.clientId)
      return true
    }
    // Error reply: relay to waiters and reset so a later initialize can retry.
    for (const waiter of initWaiters.splice(0)) {
      sendTo(waiter.transport, { ...message, id: waiter.clientId })
    }
    initForwarded = false
    initGlobalId = null
    return true
  }

  return {
    /**
     * Create a stateless per-request transport, wire its onmessage into the mux,
     * and register it live. The HTTP face hands the request to its handleRequest.
     */
    createTransport(TransportClass) {
      const transport = new TransportClass({ sessionIdGenerator: undefined })
      transport.onmessage = (message) => {
        // initialize: serve from cache / forward exactly once.
        if (message.method === 'initialize') {
          handleInitialize(transport, message)
          return
        }
        // notifications/initialized: forward exactly once; swallow the rest.
        if (message.method === 'notifications/initialized') {
          if (initializedNotified) return
          initializedNotified = true
          forwardToChild(message)
          return
        }
        // A request (has an id + method): remap the id to a global id so this
        // client's id can't collide with another's, and remember where to route
        // the child's response.
        if (message.id !== undefined && message.id !== null && typeof message.method === 'string') {
          const globalId = nextGlobalId()
          pending.set(globalId, { transport, clientId: message.id })
          forwardToChild({ ...message, id: globalId })
          return
        }
        // A bare notification / response without a routable id: forward as-is.
        forwardToChild(message)
      }
      transports.add(transport)
      return transport
    },

    /** Drop a transport once its request settles; cancel any pending it owned. */
    releaseTransport(transport) {
      transports.delete(transport)
      for (const [globalId, route] of pending) {
        if (route.transport === transport) pending.delete(globalId)
      }
    },

    /** Route one parsed child-stdout message back to the right HTTP client(s). */
    onChildMessage(message) {
      if (captureInitReply(message)) return
      // A response to a forwarded request: route it home with the client's id.
      if (message.id !== undefined && message.id !== null && pending.has(message.id)) {
        const { transport, clientId } = pending.get(message.id)!
        pending.delete(message.id)
        sendTo(transport, { ...message, id: clientId })
        return
      }
      // An id-less notification (e.g. notifications/tools/list_changed): broadcast
      // to every live transport so server->client notifications still reach clients.
      if (message.id === undefined || message.id === null) {
        for (const transport of transports) sendTo(transport, message)
        return
      }
      // A response whose id we don't recognize (e.g. the child's reply to an
      // initialize error, or a stale id after release): nothing to route it to.
      logger.warn('drop-child-frame', classifyFrame(message))
    },

    /** Close every live transport (teardown). */
    closeAll() {
      for (const transport of transports) transport.close()
      transports.clear()
      pending.clear()
    },
  }
}

export { createMultiplexer }
