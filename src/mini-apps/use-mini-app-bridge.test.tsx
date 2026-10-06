/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HttpClientProvider } from '@/contexts'
import { getActiveLocale } from '@/i18n/active-locale'
import { ThemeProvider } from '@/lib/theme-provider'
import { createClient } from '@/lib/http'
import {
  miniAppProtocolMarker,
  miniAppProtocolVersion,
  miniAppRpcErrors,
  type MiniAppHostMessage,
  type MiniAppInitializeResult,
} from '@shared/mini-app-protocol'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { Wallet } from 'lucide-react'
import {
  acceptGuestMessage,
  contextRequestTimeoutMs,
  downloadConfirmTimeoutMs,
  downloadRepromptDelayMs,
  handshakeTimeoutMs,
  identifyTimeoutMs,
  toolCallTimeoutMs,
  maxToolsChangedPerDocument,
  toolsRequestTimeoutMs,
  useMiniAppBridge,
} from './use-mini-app-bridge'
import { useMiniAppStore } from './mini-app-store'
import type { MiniAppDefinition } from './registry'

/** Stand-ins for `Window`; identity is all `acceptGuestMessage` compares. */
const frameWindow = { name: 'frame' } as unknown as Window
const otherWindow = { name: 'other' } as unknown as Window

const origin = 'http://localhost:5174'

const message = {
  jsonrpc: '2.0',
  protocol: miniAppProtocolMarker,
  method: 'ui/notifications/error',
  params: { message: 'Chart failed to render' },
}

const event = (overrides: Partial<{ source: Window | null; origin: string; data: unknown }> = {}) => ({
  source: frameWindow,
  origin,
  data: message,
  ...overrides,
})

describe('acceptGuestMessage', () => {
  it('accepts a message from the right window and origin', () => {
    const accepted = acceptGuestMessage(event(), { expectedWindow: frameWindow, expectedOrigin: origin })
    expect(accepted?.method).toBe('ui/notifications/error')
  })

  // Source and origin are independent gates. Origin alone would trust a
  // different frame on the same host; source alone would keep trusting our
  // frame after it navigated somewhere else.
  it('rejects a message from a different window on the correct origin', () => {
    const accepted = acceptGuestMessage(event({ source: otherWindow }), {
      expectedWindow: frameWindow,
      expectedOrigin: origin,
    })
    expect(accepted).toBeNull()
  })

  it('rejects a message from the right window on a different origin', () => {
    const accepted = acceptGuestMessage(event({ origin: 'http://evil.example' }), {
      expectedWindow: frameWindow,
      expectedOrigin: origin,
    })
    expect(accepted).toBeNull()
  })

  it('rejects everything before the frame has a contentWindow', () => {
    const accepted = acceptGuestMessage(event(), { expectedWindow: null, expectedOrigin: origin })
    expect(accepted).toBeNull()
  })

  it('rejects a null source', () => {
    const accepted = acceptGuestMessage(event({ source: null }), {
      expectedWindow: frameWindow,
      expectedOrigin: origin,
    })
    expect(accepted).toBeNull()
  })

  it('rejects a malformed payload even from a trusted window and origin', () => {
    const accepted = acceptGuestMessage(event({ data: { hello: 'world' } }), {
      expectedWindow: frameWindow,
      expectedOrigin: origin,
    })
    expect(accepted).toBeNull()
  })

  // Origins compare exactly — a prefix match would accept
  // `http://localhost:51740`, and a suffix match an attacker-chosen subdomain.
  it('does not accept an origin that merely shares a prefix', () => {
    const accepted = acceptGuestMessage(event({ origin: 'http://localhost:51740' }), {
      expectedWindow: frameWindow,
      expectedOrigin: origin,
    })
    expect(accepted).toBeNull()
  })
})

/*
 * The message handler itself, driven through a real mount.
 *
 * Everything above tests the door; this tests the room. It goes through
 * `render` rather than calling an extracted function because the bugs this is
 * here to catch have all been wiring bugs — a reply shape the guest can't
 * match, a capability gate that reads a stale ref, an effect that doesn't
 * re-run on reconnect. A handler tested in isolation would have passed while
 * the handshake was dead on the wire, which is exactly what happened.
 */

const app: MiniAppDefinition = {
  id: 'finance',
  name: 'Finance',
  description: 'Books and forecasts.',
  icon: Wallet,
  url: 'http://localhost:5174/',
  origin,
}

type Bridge = ReturnType<typeof useMiniAppBridge>

const token = { token: 'jwt.for.finance', expiresAt: '2099-01-01T00:00:00.000Z' }

/** An HTTP client that answers every call with a token and remembers who asked. */
const recordingHttpClient = () => {
  const paths: string[] = []
  const signals: AbortSignal[] = []
  const client = createClient({
    prefixUrl: 'http://test-api.local',
    fetch: async (input: Request | string | URL) => {
      paths.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname)
      if (input instanceof Request && input.signal) {
        signals.push(input.signal)
      }
      return new Response(JSON.stringify(token), { headers: { 'Content-Type': 'application/json' } })
    },
  })
  return { client, paths, signals }
}

/** A client whose token route always fails, the way a 500 or an offline tab would. */
const failingHttpClient = () =>
  createClient({
    prefixUrl: 'http://test-api.local',
    fetch: async () => new Response('nope', { status: 500 }),
  })

const mountBridge = (onChatOpen: (prompt?: string) => void = () => {}, httpClient = recordingHttpClient().client) => {
  const bridge: { current: Bridge | null } = { current: null }

  const Harness = () => {
    bridge.current = useMiniAppBridge({ app, onChatOpen })
    return <iframe ref={bridge.current.frameRef} title={app.name} src="about:blank" />
  }

  const { unmount } = render(
    <ThemeProvider>
      <HttpClientProvider httpClient={httpClient}>
        <Harness />
      </HttpClientProvider>
    </ThemeProvider>,
  )

  const frame = document.querySelector('iframe') as HTMLIFrameElement
  const guest = frame.contentWindow as Window
  const posted: MiniAppHostMessage[] = []
  guest.postMessage = ((message: MiniAppHostMessage) => posted.push(message)) as Window['postMessage']

  /**
   * Deliver a guest message the way the browser would, and let the handler
   * finish.
   *
   * Advancing the shared clock rather than awaiting a fixed number of
   * microtasks: the handler may mint a token through a real client, so the
   * number of ticks it needs is an implementation detail of `ky` and of this
   * hook. A count that happens to be right today silently stops waiting long
   * enough the moment either gains an `await`.
   */
  const settle = async () => {
    await act(async () => {
      await getClock().tickAsync(1)
    })
  }

  const send = async (data: unknown) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data, origin, source: guest }))
    })
    await settle()
  }

  /** Advance past one of the bridge's deadlines. */
  const elapse = async (ms: number) => {
    await act(async () => {
      await getClock().tickAsync(ms)
    })
  }

  const envelope = (rest: Record<string, unknown>) => ({ jsonrpc: '2.0', protocol: miniAppProtocolMarker, ...rest })

  /** The reply to one request — the host also posts unsolicited notifications. */
  const replyTo = (id: number | string) => posted.find((message) => 'id' in message && message.id === id)

  /**
   * `documentId` defaults to a real one, because a real guest sends one — and
   * the frame-load path behaves differently without it, on purpose. Pass `null`
   * to model a guest on an SDK copy that predates the field.
   */
  const handshake = (
    capabilities: Record<string, boolean> = {},
    { version = miniAppProtocolVersion, documentId = 'doc-a' as string | null, id = 1 } = {},
  ) =>
    send(
      envelope({
        id,
        method: 'ui/initialize',
        params: { protocolVersion: version, capabilities, ...(documentId === null ? {} : { documentId }) },
      }),
    )

  /** Every `ui/identify` the host has asked, oldest first. */
  const identifyIds = () =>
    posted
      .filter((message) => 'method' in message && message.method === 'ui/identify')
      .map((message) => (message as { id: number }).id)

  /**
   * Answer one `ui/identify`. Defaults to the most recent, which is the one a
   * live document would be replying to; pass an index to answer an older one
   * and model a reply that a later load has overtaken.
   */
  const answerIdentify = async (documentId: string | null, index = -1) => {
    const ids = identifyIds()
    const id = ids.at(index)
    if (id === undefined) {
      throw new Error(`the host asked ${ids.length} ui/identify requests; no index ${index}`)
    }
    await send(envelope({ id, result: { documentId } }))
  }

  return { bridge, posted, replyTo, send, settle, elapse, envelope, handshake, answerIdentify, identifyIds, unmount }
}

beforeEach(() => {
  // `activeApp` included: it is module-level state another file may have left
  // set, and these tests assume nothing is open until they open it.
  useMiniAppStore.setState({ activeApp: null, tools: [], invokeTool: null })
})

describe('useMiniAppBridge deadlines', () => {
  /**
   * The failure the code calls "the single most confusing failure mode when
   * demoing": the app isn't running, or its `frame-ancestors` refuses us, and
   * nothing ever arrives. Without the deadline the panel sits at "connecting"
   * forever with nothing to click.
   */
  it('calls the app unreachable when no handshake arrives', async () => {
    const { bridge, elapse } = mountBridge()

    expect(bridge.current?.status).toBe('connecting')

    await elapse(handshakeTimeoutMs)

    expect(bridge.current?.status).toBe('unreachable')
  })

  it('does not call it unreachable once it has handshaked', async () => {
    const { bridge, handshake, elapse } = mountBridge()
    await handshake()

    await elapse(handshakeTimeoutMs)

    expect(bridge.current?.status).toBe('ready')
  })
})

describe('useMiniAppBridge tool discovery', () => {
  /** Asked once, after the handshake, and only of an app that said it has tools. */
  it('asks for the tool list when the app declares the capability', async () => {
    const { posted, handshake } = mountBridge()

    await handshake({ tools: true })

    expect(posted.some((message) => 'method' in message && message.method === 'tools/list')).toBe(true)
  })

  it('does not ask an app that never declared tools', async () => {
    const { posted, handshake } = mountBridge()

    await handshake()

    expect(posted.some((message) => 'method' in message && message.method === 'tools/list')).toBe(false)
  })

  it('publishes the tools it is given, with a way to call them', async () => {
    const { posted, handshake, send, envelope } = mountBridge()
    await handshake({ tools: true })
    const request = posted.find((message) => 'method' in message && message.method === 'tools/list')

    await send(
      envelope({
        id: (request as { id: number }).id,
        result: { tools: [{ name: 'set_assumption', description: 'Change one assumption.' }] },
      }),
    )

    expect(useMiniAppStore.getState().tools.map((tool) => tool.name)).toEqual(['set_assumption'])
    expect(useMiniAppStore.getState().invokeTool).not.toBeNull()
  })

  /** An app that declares `tools` and then never answers must not leave the
   *  model holding a toolset that will never arrive. */
  it('survives an app that never answers the tool list', async () => {
    const { handshake, elapse } = mountBridge()
    await handshake({ tools: true })

    await elapse(toolsRequestTimeoutMs)

    expect(useMiniAppStore.getState().tools).toEqual([])
  })

  /**
   * The gate that lets `document.modelContext.registerTool()` work at all.
   *
   * A guest registering tools the canonical way has nothing to declare at
   * handshake time — the registry is still empty when `initialize` goes out,
   * because the call that fills it is in an effect. So the notification is the
   * declaration, and it has to open the same gate.
   */
  it('asks for the tool list when an app that declared nothing says its tools changed', async () => {
    const { posted, handshake, send, envelope } = mountBridge()
    await handshake()
    expect(posted.some((message) => 'method' in message && message.method === 'tools/list')).toBe(false)

    await send(envelope({ method: 'ui/notifications/tools-changed', params: {} }))

    expect(posted.some((message) => 'method' in message && message.method === 'tools/list')).toBe(true)
  })

  it('re-lists rather than reusing the list it already has', async () => {
    const { posted, handshake, send, envelope } = mountBridge()
    await handshake({ tools: true })
    const first = posted.find((message) => 'method' in message && message.method === 'tools/list')
    await send(envelope({ id: (first as { id: number }).id, result: { tools: [{ name: 'early', description: 'a' }] } }))

    await send(envelope({ method: 'ui/notifications/tools-changed', params: {} }))
    const second = posted.filter((message) => 'method' in message && message.method === 'tools/list')
    await send(
      envelope({
        id: (second[1] as { id: number }).id,
        result: {
          tools: [
            { name: 'early', description: 'a' },
            { name: 'late', description: 'b' },
          ],
        },
      }),
    )

    expect(second).toHaveLength(2)
    expect(useMiniAppStore.getState().tools.map((tool) => tool.name)).toEqual(['early', 'late'])
  })

  /** Accepted without `params` at all, which is valid JSON-RPC for a notification. */
  it('accepts the notification with no params', async () => {
    const { posted, handshake, send, envelope } = mountBridge()
    await handshake()

    await send(envelope({ method: 'ui/notifications/tools-changed' }))

    expect(posted.some((message) => 'method' in message && message.method === 'tools/list')).toBe(true)
  })

  /**
   * Each notification costs a `tools/list` with its own deadline, and the frame
   * decides how often to send one. A register/unregister loop in the guest must
   * not turn into unbounded work here.
   */
  it('stops re-listing once the guest has spent its allowance', async () => {
    const { posted, handshake, send, envelope } = mountBridge()
    await handshake()

    for (let sent = 0; sent < maxToolsChangedPerDocument + 5; sent += 1) {
      await send(envelope({ method: 'ui/notifications/tools-changed', params: {} }))
    }

    const lists = posted.filter((message) => 'method' in message && message.method === 'tools/list')
    expect(lists).toHaveLength(maxToolsChangedPerDocument)
  })

  /** A reload is a new document, so it gets a fresh allowance and a fresh list. */
  it('gives a re-handshaked document its allowance back', async () => {
    const { posted, handshake, send, envelope } = mountBridge()
    await handshake()
    for (let sent = 0; sent < maxToolsChangedPerDocument; sent += 1) {
      await send(envelope({ method: 'ui/notifications/tools-changed', params: {} }))
    }

    await handshake({}, { documentId: 'doc-b', id: 2 })
    await send(envelope({ method: 'ui/notifications/tools-changed', params: {} }))

    const lists = posted.filter((message) => 'method' in message && message.method === 'tools/list')
    expect(lists).toHaveLength(maxToolsChangedPerDocument + 1)
  })
})

describe('useMiniAppBridge tool calls', () => {
  /** Read the invoker the bridge published, which is what the model's toolset holds. */
  const invokerFrom = async (bridge: ReturnType<typeof mountBridge>) => {
    await bridge.handshake({ tools: true })
    const request = bridge.posted.find((message) => 'method' in message && message.method === 'tools/list')
    await bridge.send(
      bridge.envelope({
        id: (request as { id: number }).id,
        result: { tools: [{ name: 'set_assumption', description: 'Change one assumption.' }] },
      }),
    )
    const invoke = useMiniAppStore.getState().invokeTool
    if (!invoke) {
      throw new Error('the bridge published no invoker')
    }
    return invoke
  }

  it('returns what the app answered', async () => {
    const harness = mountBridge()
    const invoke = await invokerFrom(harness)

    let result: unknown
    const call = invoke('set_assumption', { growth: 0.2 }).then((value) => {
      result = value
    })
    const request = harness.posted.find((message) => 'method' in message && message.method === 'tools/call')
    await harness.send(harness.envelope({ id: (request as { id: number }).id, result: { content: 'done' } }))
    await call

    expect(result).toEqual({ content: 'done' })
  })

  /**
   * A tool call blocks a model turn, so "no answer" has to become an answer.
   * Left hanging, the turn spins behind a spinner with no explanation.
   */
  it('gives the model something to say when the app never answers', async () => {
    const harness = mountBridge()
    const invoke = await invokerFrom(harness)

    let result: { content: string; isError?: boolean } | undefined
    const call = invoke('set_assumption', {}).then((value) => {
      result = value
    })
    await harness.elapse(toolCallTimeoutMs)
    await call

    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('did not return a usable result')
  })

  it('reports an error the app returns as a tool error, not a crash', async () => {
    const harness = mountBridge()
    const invoke = await invokerFrom(harness)

    let result: { content: string; isError?: boolean } | undefined
    const call = invoke('set_assumption', {}).then((value) => {
      result = value
    })
    const request = harness.posted.find((message) => 'method' in message && message.method === 'tools/call')
    await harness.send(
      harness.envelope({
        id: (request as { id: number }).id,
        error: { code: -32000, message: 'the assumption is locked' },
      }),
    )
    await call

    expect(result).toEqual({ content: 'the assumption is locked', isError: true })
  })
})

describe('useMiniAppBridge message handling', () => {
  it('answers the handshake and marks the app ready', async () => {
    const { bridge, replyTo, handshake } = mountBridge()
    await handshake()

    const reply = replyTo(1) as { result: MiniAppInitializeResult }
    expect(reply.result.protocolVersion).toBe(miniAppProtocolVersion)
    expect(reply.result.capabilities).toMatchObject({ context: true, chat: true })
    expect(bridge.current?.status).toBe('ready')
  })

  /*
   * `navigator.language` is the browser's install language, which has nothing to
   * do with the one the user picked in Thunderbolt. The guest formats currency and
   * dates off this, so getting it wrong renders a German UI beside US-formatted
   * money — which is exactly what shipped before.
   */
  it('tells the guest the app language, not the browser language', async () => {
    const { replyTo, handshake } = mountBridge()
    await handshake()

    const reply = replyTo(1) as { result: MiniAppInitializeResult }
    expect(reply.result.hostContext.locale).toBe(getActiveLocale())
  })

  it('refuses a protocol version it does not speak, and stays unready', async () => {
    const { bridge, replyTo, handshake } = mountBridge()
    await handshake({}, { version: 99 })

    expect(replyTo(1)).toMatchObject({ error: { code: miniAppRpcErrors.unsupportedProtocolVersion } })
    expect(bridge.current?.status).toBe('connecting')
  })

  /*
   * Pulled, not cached. The host asks on every `get_app_context`, so state the
   * user changed a moment ago is in the answer without the app having had to
   * notify anyone.
   */
  it('asks the app for its context and returns what it answers', async () => {
    const { bridge, posted, send, envelope, handshake, settle } = mountBridge()
    await handshake({ context: true })

    let inFlight: Promise<unknown> = Promise.resolve(null)
    await act(async () => {
      inFlight = bridge.current!.requestContext()
    })
    const asked = posted.find((m) => 'method' in m && m.method === 'ui/get-context')
    expect(asked).toBeDefined()
    await send(envelope({ id: (asked as { id: number }).id, result: { context: { title: 'Q3', summary: '4.2M' } } }))
    await settle()

    expect(await inFlight).toEqual({ title: 'Q3', summary: '4.2M' })
  })

  it('reports no context for an app that never declared the capability', async () => {
    const { bridge, posted, handshake } = mountBridge()
    await handshake()

    expect(await bridge.current!.requestContext()).toBeNull()
    // Not even asked: the capability is the contract, so `get_app_context` can
    // say "this app reports no state" instead of waiting out a deadline.
    expect(posted.find((m) => 'method' in m && m.method === 'ui/get-context')).toBeUndefined()
  })

  /*
   * The whole point of the pull. A cache could be confidently stale; this can
   * only be absent, and absent is something the model can be told.
   */
  it('reports no context when the app does not answer in time', async () => {
    const { bridge, handshake, elapse } = mountBridge()
    await handshake({ context: true })

    let inFlight: Promise<unknown> = Promise.resolve('unset')
    await act(async () => {
      inFlight = bridge.current!.requestContext()
    })
    await elapse(contextRequestTimeoutMs + 100)

    expect(await inFlight).toBeNull()
  })

  // The capability is the contract, not a hint: an app that said it doesn't
  // report selections must not get our selection control floated over it.
  it('ignores a selection from an app that never declared the capability', async () => {
    const { bridge, send, envelope, handshake } = mountBridge()
    await handshake({ selection: false })
    await send(envelope({ method: 'ui/notifications/selection-changed', params: { selection: { text: 'hi' } } }))

    expect(bridge.current?.selection).toBeNull()
  })

  it('surfaces a selection once the app has declared it', async () => {
    const { bridge, send, envelope, handshake } = mountBridge()
    await handshake({ selection: true })
    await send(envelope({ method: 'ui/notifications/selection-changed', params: { selection: { text: 'hi' } } }))

    expect(bridge.current?.selection).toEqual({ text: 'hi' })
  })

  // Otherwise an app could decline `auth` at initialize — so no token was minted,
  // exactly as documented — and then simply ask for one afterwards.
  it('refuses a token to an app that declined the auth capability', async () => {
    const { client, paths } = recordingHttpClient()
    const { replyTo, send, envelope, handshake } = mountBridge(() => {}, client)
    await handshake({ auth: false })
    await send(envelope({ id: 7, method: 'ui/request-auth-token', params: {} }))

    expect(replyTo(7)).toMatchObject({
      error: { code: miniAppRpcErrors.authUnavailable, message: 'app did not declare the auth capability' },
    })
    // The refusal has to happen before the network, not after: a token minted
    // and then thrown away has still been minted.
    expect(paths).toEqual([])
  })

  it('mints a token for an app that declared auth, and refreshes it on request', async () => {
    const { client, paths } = recordingHttpClient()
    const { replyTo, send, envelope, handshake } = mountBridge(() => {}, client)
    await handshake({ auth: true })

    expect(replyTo(1)).toMatchObject({ result: { capabilities: { auth: true }, auth: token } })

    await send(envelope({ id: 7, method: 'ui/request-auth-token', params: {} }))

    expect(replyTo(7)).toMatchObject({ result: token })
    expect(paths).toEqual(['/mini-apps/finance/token', '/mini-apps/finance/token'])
  })

  /*
   * `ui/request-auth-token` pinned its id to a number while every sibling request
   * took `string | number`, so a guest whose JSON-RPC library mints string ids
   * uniformly — a perfectly ordinary choice — had this one message fail the
   * discriminated-union parse and vanish with no reply. Token refresh simply
   * stopped, and a frame that outlived its token had no way back.
   */
  it('answers a token request that uses a string id, like every other request', async () => {
    const { replyTo, send, envelope, handshake } = mountBridge()
    await handshake({ auth: true })
    await send(envelope({ id: 'refresh-1', method: 'ui/request-auth-token', params: {} }))

    expect(replyTo('refresh-1')).toMatchObject({ result: token })
  })

  /*
   * The mint is on the handshake's critical path, so a slow or broken token route
   * must not cost the app its auth capability. `capabilities.auth` answers "will
   * you serve `ui/request-auth-token`" — reporting it as false because one mint
   * failed told a guest to stop asking, which is the documented meaning of false
   * and the opposite of what we want here.
   */
  it('keeps the auth capability when the initial mint fails, so the guest retries', async () => {
    const { bridge, replyTo, handshake } = mountBridge(() => {}, failingHttpClient())
    await handshake({ auth: true })

    const reply = replyTo(1) as { result: MiniAppInitializeResult }
    expect(reply.result.capabilities.auth).toBe(true)
    expect(reply.result.auth).toBeUndefined()
    // A missing token is a degraded app, not a broken host.
    expect(bridge.current?.status).toBe('ready')
  })

  it('abandons an in-flight mint when the user navigates away mid-handshake', async () => {
    const { client, signals } = recordingHttpClient()
    const { handshake, unmount } = mountBridge(() => {}, client)
    await handshake({ auth: true })

    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)

    unmount()

    expect(signals[0]?.aborted).toBe(true)
  })

  it('acknowledges an open-chat request before acting on it', async () => {
    const prompts: (string | undefined)[] = []
    const { replyTo, send, envelope, handshake } = mountBridge((prompt) => prompts.push(prompt))
    await handshake()
    await send(envelope({ id: 3, method: 'ui/open-chat', params: { prompt: 'explain this' } }))

    expect(replyTo(3)).toMatchObject({ result: { opened: true } })
    expect(prompts).toEqual(['explain this'])
  })

  it('shows a runtime error the app reports', async () => {
    const { bridge, send, envelope, handshake } = mountBridge()
    await handshake()
    await send(envelope({ method: 'ui/notifications/error', params: { message: 'Chart failed to render' } }))

    expect(bridge.current?.runtimeError).toBe('Chart failed to render')
  })

  /*
   * A frame can re-initialize without unmounting — the app navigated, reloaded,
   * or was redeployed. Everything the previous document told us describes a page
   * that no longer exists; serving its tools to the model means calling functions
   * into a document that never defined them.
   */
  it('drops the previous document state when a different document handshakes', async () => {
    const { send, envelope, handshake } = mountBridge()
    await handshake()
    useMiniAppStore.getState().setTools([{ name: 'refresh', description: 'Reload the books' }], async () => ({
      content: '',
    }))
    await send(envelope({ method: 'ui/notifications/error', params: { message: 'Chart failed to render' } }))

    await handshake({}, { documentId: 'doc-b', id: 2 })

    expect(useMiniAppStore.getState().tools).toEqual([])
  })

  it('clears a runtime error left over from the previous document', async () => {
    const { bridge, send, envelope, handshake } = mountBridge()
    await handshake()
    await send(envelope({ method: 'ui/notifications/error', params: { message: 'Chart failed to render' } }))
    await handshake({}, { documentId: 'doc-b', id: 2 })

    expect(bridge.current?.runtimeError).toBeNull()
  })

  /**
   * React's StrictMode double-invokes the effect that calls `connect()`, so one
   * document handshaking twice is routine. It used to read as a new document:
   * capabilities and tool list thrown away and rediscovered, for a page that had
   * not changed (THU-908).
   */
  it('leaves everything in place when the same document handshakes twice', async () => {
    const { bridge, replyTo, handshake } = mountBridge()
    await handshake({ tools: true })
    useMiniAppStore.getState().setTools([{ name: 'refresh', description: 'Reload the books' }], async () => ({
      content: '',
    }))

    await handshake({ tools: true }, { id: 2 })

    expect(useMiniAppStore.getState().tools.map((tool) => tool.name)).toEqual(['refresh'])
    expect(bridge.current?.status).toBe('ready')
    // Still answered in full: the second `connect()` is waiting on a reply and
    // has no idea the first one happened.
    expect(replyTo(2)).toMatchObject({ result: { hostName: 'Thunderbolt' } })
  })

  /** A guest with no id to compare cannot be recognised, so it stays the old way. */
  it('treats a repeat from a guest with no document id as a new document', async () => {
    const { handshake } = mountBridge()
    await handshake({}, { documentId: null })
    useMiniAppStore.getState().setTools([{ name: 'refresh', description: 'Reload the books' }], async () => ({
      content: '',
    }))

    await handshake({}, { documentId: null, id: 2 })

    expect(useMiniAppStore.getState().tools).toEqual([])
  })

  /*
   * The failure this guards: a frame reloads into a page that never connects, and
   * the host keeps saying `ready` — Select and Chat stay lit over a dead document
   * and every tool call the model makes waits out its full timeout.
   */
  it('goes back to connecting when a new document loads and does not identify', async () => {
    const { bridge, handshake, elapse } = mountBridge()
    await handshake()

    act(() => bridge.current?.handleFrameLoad())
    await elapse(identifyTimeoutMs)

    expect(bridge.current?.status).toBe('connecting')
  })

  it('clears a runtime error when a new document loads and does not identify', async () => {
    const { bridge, send, envelope, handshake, elapse } = mountBridge()
    await handshake()
    await send(envelope({ method: 'ui/notifications/error', params: { message: 'Chart failed to render' } }))

    act(() => bridge.current?.handleFrameLoad())
    await elapse(identifyTimeoutMs)

    expect(bridge.current?.runtimeError).toBeNull()
  })

  /**
   * The ordering this used to guess at (THU-908). A plain-script guest posts
   * `initialize` before its own `load` reaches us, so the handshake in hand
   * really is the live document's — and it says so when asked.
   */
  it('stays ready when the live document identifies as the one that handshaked', async () => {
    const { bridge, handshake, answerIdentify } = mountBridge()
    await handshake()

    act(() => bridge.current?.handleFrameLoad())
    await answerIdentify('doc-a')

    expect(bridge.current?.status).toBe('ready')
  })

  /**
   * The other ordering, and the case the old flag got wrong: a React guest
   * handshakes *after* its load, so at the next load the flag said "the document
   * that just committed handshaked" when the handshake belonged to the page that
   * had gone away. Select and Chat stayed lit over a dead document.
   */
  it('resets when the live document identifies as a different one', async () => {
    const { bridge, handshake, answerIdentify } = mountBridge()
    await handshake()

    act(() => bridge.current?.handleFrameLoad())
    await answerIdentify('doc-b')

    expect(bridge.current?.status).toBe('connecting')
  })

  /**
   * A guest that answers but has no id to give is present without identity —
   * an SDK copy that predates the field, reached through the `ui/identify`
   * handler it does not have. Treated as a different document, because presence
   * alone cannot vouch for the handshake we are holding.
   */
  it('resets when the live document answers without an id', async () => {
    const { bridge, handshake, answerIdentify } = mountBridge()
    await handshake()

    act(() => bridge.current?.handleFrameLoad())
    await answerIdentify(null)

    expect(bridge.current?.status).toBe('connecting')
  })

  /**
   * The new document can handshake while the confirmation for the old one is
   * still in flight. Comparing the reply against the id captured when the
   * question was asked would tear down the handshake that had just succeeded.
   */
  it('does not reset a document that handshaked while the confirmation was pending', async () => {
    const { bridge, handshake, answerIdentify } = mountBridge()
    await handshake()

    act(() => bridge.current?.handleFrameLoad())
    await handshake({}, { documentId: 'doc-b', id: 2 })
    await answerIdentify('doc-b')

    expect(bridge.current?.status).toBe('ready')
  })

  /**
   * The same race as the test above, but with no reply at all. A guest answers
   * `ui/identify` only between `connect()` and `disconnect()`, so a document
   * that handshaked and then tore its bridge down inside this deadline says
   * nothing — and a timeout is indistinguishable from a wrong id at the parse.
   * Resetting on it would clear a document the frame had already confirmed by
   * handshaking, then wait for an `initialize` it has no reason to send again.
   */
  it('keeps a document that handshaked while the confirmation went unanswered', async () => {
    const { bridge, handshake, elapse } = mountBridge()
    await handshake()

    act(() => bridge.current?.handleFrameLoad())
    await handshake({}, { documentId: 'doc-b', id: 2 })
    await elapse(identifyTimeoutMs)

    expect(bridge.current?.status).toBe('ready')
  })

  /**
   * A frame can commit twice inside one confirmation's deadline — a redirect
   * chain, or a user mashing reload. The first load's reply then describes a
   * document two generations old, and acting on it would vouch for a handshake
   * nothing has confirmed.
   */
  it('ignores a confirmation that a later load has overtaken', async () => {
    const { bridge, handshake, answerIdentify, elapse } = mountBridge()
    await handshake()
    act(() => bridge.current?.handleFrameLoad())
    act(() => bridge.current?.handleFrameLoad())

    // The first question, answered after the second was asked.
    await answerIdentify('doc-a', 0)
    // The second goes unanswered, which is what decides it.
    await elapse(identifyTimeoutMs)

    expect(bridge.current?.status).toBe('connecting')
  })

  /**
   * The same overtaking, the other way round, and the one that actually costs
   * something: the *newer* question is answered and the older one's deadline
   * expires afterwards. A timeout is indistinguishable from a wrong id at the
   * parse, so without the generation check that stale expiry tears down a
   * document a live reply had just confirmed — half a second after everything
   * looked fine.
   */
  it('keeps a confirmed document when an overtaken confirmation later times out', async () => {
    const { bridge, handshake, answerIdentify, elapse } = mountBridge()
    await handshake()
    act(() => bridge.current?.handleFrameLoad())
    act(() => bridge.current?.handleFrameLoad())

    await answerIdentify('doc-a')
    await elapse(identifyTimeoutMs)

    expect(bridge.current?.status).toBe('ready')
  })

  /**
   * An empty string is a guest with no id to give. The protocol lets one
   * through rather than dropping the handshake over it — a floor on a field
   * riding `initialize` rejects the whole message, and the app would see only a
   * timeout — so the host has to read it as absent at both ends.
   */
  it('treats an empty document id as no id at all', async () => {
    const { bridge, posted, handshake } = mountBridge()
    await handshake({}, { documentId: '' })

    expect(bridge.current?.status).toBe('ready')

    act(() => bridge.current?.handleFrameLoad())

    expect(posted.some((message) => 'method' in message && message.method === 'ui/identify')).toBe(false)
  })

  /**
   * A guest that cannot be asked keeps the old best-effort guess. Wrong for a
   * React app that navigates, right for everything else — and strictly better
   * than resetting a live document on every load, which is what asking a guest
   * that will never answer would do.
   */
  it('falls back to the load-ordering guess for a guest with no document id', async () => {
    const { bridge, handshake, elapse } = mountBridge()
    await handshake({}, { documentId: null })

    act(() => bridge.current?.handleFrameLoad())
    await elapse(identifyTimeoutMs)

    expect(bridge.current?.status).toBe('ready')
  })

  it('does not ask a guest with no document id to identify', async () => {
    const { bridge, posted, handshake } = mountBridge()
    await handshake({}, { documentId: null })

    act(() => bridge.current?.handleFrameLoad())

    expect(posted.some((message) => 'method' in message && message.method === 'ui/identify')).toBe(false)
  })
})

describe('useMiniAppBridge downloads', () => {
  /** A `ui/download-file` request for a small CSV, as the SDK sends it. */
  const downloadRequest = (id: number, uri = 'file:///export.csv') => ({
    id,
    method: 'ui/download-file',
    params: { contents: [{ type: 'resource', resource: { uri, mimeType: 'text/csv', text: 'a,b' } }] },
  })

  /**
   * Record what the web save path hands the browser. The blob is the download
   * there, so a request that never reaches `createObjectURL` saved nothing.
   */
  const recordSaves = () => {
    const saved: Blob[] = []
    const original = URL.createObjectURL
    URL.createObjectURL = (blob: Blob) => {
      saved.push(blob)
      return 'blob:test'
    }
    return { saved, restore: () => (URL.createObjectURL = original) }
  }

  it('tells the app at the handshake that it can save files', async () => {
    const { replyTo, handshake } = mountBridge()
    await handshake()

    expect(replyTo(1)).toMatchObject({ result: { capabilities: { downloadFile: true } } })
  })

  it('asks the user first, and saves only once they agree', async () => {
    const { saved, restore } = recordSaves()
    try {
      const { bridge, replyTo, send, envelope, handshake, settle } = mountBridge()
      await handshake()
      await send(envelope(downloadRequest(9)))

      expect(bridge.current?.pendingDownload).toEqual({ name: 'export.csv' })
      expect(replyTo(9)).toBeUndefined()
      expect(saved).toHaveLength(0)

      await act(async () => bridge.current?.answerDownload(true))
      await settle()

      expect(replyTo(9)).toMatchObject({ result: {} })
      expect(bridge.current?.pendingDownload).toBeNull()
      expect(saved.map((blob) => blob.type)).toEqual(['text/csv'])
    } finally {
      restore()
    }
  })

  it('saves nothing and says so when the user declines', async () => {
    const { saved, restore } = recordSaves()
    try {
      const { bridge, replyTo, send, envelope, handshake, settle } = mountBridge()
      await handshake()
      await send(envelope(downloadRequest(9)))
      await act(async () => bridge.current?.answerDownload(false))
      await settle()

      expect(replyTo(9)).toMatchObject({
        error: { code: miniAppRpcErrors.downloadRejected, message: 'Download denied by user' },
      })
      expect(saved).toHaveLength(0)
    } finally {
      restore()
    }
  })

  /** Refused before the prompt: the user is never asked about a file that would not be saved. */
  it('refuses a disallowed file without asking', async () => {
    const { bridge, replyTo, send, envelope, handshake } = mountBridge()
    await handshake()
    await send(envelope(downloadRequest(9, 'file:///setup.exe')))

    expect(replyTo(9)).toMatchObject({
      error: { code: miniAppRpcErrors.downloadRejected, message: 'Policy violation: .exe files are not saved' },
    })
    expect(bridge.current?.pendingDownload).toBeNull()
  })

  it('answers a malformed request instead of leaving the app waiting', async () => {
    const { replyTo, send, envelope, handshake } = mountBridge()
    await handshake()
    await send(envelope({ id: 9, method: 'ui/download-file', params: { contents: 'nope' } }))

    expect(replyTo(9)).toMatchObject({ error: { code: miniAppRpcErrors.downloadRejected } })
  })

  /** One prompt at a time, so an app cannot stack prompts the user dismisses one by one. */
  it('refuses a second request while the first is waiting', async () => {
    const { bridge, replyTo, send, envelope, handshake } = mountBridge()
    await handshake()
    await send(envelope(downloadRequest(9)))
    // Disallowed on purpose: the guard answers before the request is even parsed.
    await send(envelope(downloadRequest(10, 'file:///setup.exe')))

    expect(replyTo(10)).toMatchObject({ error: { message: 'Another download is waiting for the user' } })
    expect(replyTo(9)).toBeUndefined()
    expect(bridge.current?.pendingDownload).toEqual({ name: 'export.csv' })
  })

  /** Reported as expired, not denied: the user never said no. */
  it('gives up on its own when nobody answers, without calling it a refusal', async () => {
    const { bridge, replyTo, send, envelope, handshake, elapse } = mountBridge()
    await handshake()
    await send(envelope(downloadRequest(9)))
    await elapse(downloadConfirmTimeoutMs)

    expect(replyTo(9)).toMatchObject({ error: { message: 'Download expired: nobody answered the prompt' } })
    expect(bridge.current?.pendingDownload).toBeNull()
  })

  /** The prompt is modal: re-asking the moment the user cancels would keep them from leaving. */
  it('makes the app wait before asking again after a refusal', async () => {
    const { bridge, replyTo, send, envelope, handshake, settle, elapse } = mountBridge()
    await handshake()
    await send(envelope(downloadRequest(9)))
    await act(async () => bridge.current?.answerDownload(false))
    await settle()
    await send(envelope(downloadRequest(10)))

    expect(replyTo(10)).toMatchObject({
      error: { message: 'Download refused: asked again too soon after a declined or expired prompt' },
    })
    expect(bridge.current?.pendingDownload).toBeNull()

    await elapse(downloadRepromptDelayMs)
    await send(envelope(downloadRequest(11)))

    expect(bridge.current?.pendingDownload).toEqual({ name: 'export.csv' })
  })

  it('does not hold an approved save against the next one', async () => {
    const { saved, restore } = recordSaves()
    try {
      const { bridge, send, envelope, handshake, settle } = mountBridge()
      await handshake()
      await send(envelope(downloadRequest(9)))
      await act(async () => bridge.current?.answerDownload(true))
      await settle()
      await send(envelope(downloadRequest(10, 'file:///second.csv')))

      expect(bridge.current?.pendingDownload).toEqual({ name: 'second.csv' })
      expect(saved).toHaveLength(1)
    } finally {
      restore()
    }
  })

  /** The page that asked is gone, so approving now would save its file under the one that replaced it. */
  it('cancels a waiting save when a new document loads', async () => {
    const { saved, restore } = recordSaves()
    try {
      const { bridge, replyTo, send, envelope, handshake, settle } = mountBridge()
      await handshake()
      await send(envelope(downloadRequest(9)))
      act(() => bridge.current?.handleFrameLoad())
      await settle()

      expect(bridge.current?.pendingDownload).toBeNull()
      expect(replyTo(9)).toMatchObject({
        error: {
          code: miniAppRpcErrors.downloadRejected,
          message: 'Download cancelled: the app navigated away before the user answered',
        },
      })

      await act(async () => bridge.current?.answerDownload(true))
      await settle()

      expect(saved).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it('saves nothing when the app goes away mid-prompt, even after the deadline', async () => {
    const { saved, restore } = recordSaves()
    try {
      const { send, envelope, handshake, unmount, elapse } = mountBridge()
      await handshake()
      await send(envelope(downloadRequest(9)))
      unmount()
      await elapse(downloadConfirmTimeoutMs)

      expect(saved).toHaveLength(0)
    } finally {
      restore()
    }
  })

  /** The platform's message reaches the app, so it can say why rather than that. */
  it('reports a save that failed with the platform message', async () => {
    const original = URL.createObjectURL
    URL.createObjectURL = () => {
      throw new Error('quota exceeded')
    }
    try {
      const { bridge, replyTo, send, envelope, handshake, settle } = mountBridge()
      await handshake()
      await send(envelope(downloadRequest(9)))
      await act(async () => bridge.current?.answerDownload(true))
      await settle()

      expect(replyTo(9)).toMatchObject({
        error: { code: miniAppRpcErrors.downloadRejected, message: 'quota exceeded' },
      })
    } finally {
      URL.createObjectURL = original
    }
  })
})
