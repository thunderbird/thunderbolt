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
import { Wallet } from 'lucide-react'
import { acceptGuestMessage, useMiniAppBridge } from './use-mini-app-bridge'
import { useMiniAppStore } from './mini-app-store'
import type { MiniAppDefinition } from './registry'

/** Stand-ins for `Window`; identity is all `acceptGuestMessage` compares. */
const frameWindow = { name: 'frame' } as unknown as Window
const otherWindow = { name: 'other' } as unknown as Window

const origin = 'http://localhost:5174'

const message = {
  jsonrpc: '2.0',
  protocol: miniAppProtocolMarker,
  method: 'ui/update-model-context',
  params: { context: { title: 'Q3', summary: 'Revenue model.' } },
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
    expect(accepted?.method).toBe('ui/update-model-context')
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
 * `render` rather than calling a extracted function because the bugs this is
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

  /** Deliver a guest message the way the browser would, and let the handler finish. */
  const send = async (data: unknown) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data, origin, source: guest }))
      // The handler is async (it may mint a token); yield until it settles.
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const envelope = (rest: Record<string, unknown>) => ({ jsonrpc: '2.0', protocol: miniAppProtocolMarker, ...rest })

  /** The reply to one request — the host also posts unsolicited notifications. */
  const replyTo = (id: number | string) => posted.find((message) => 'id' in message && message.id === id)

  const handshake = (capabilities: Record<string, boolean> = {}, version = miniAppProtocolVersion) =>
    send(envelope({ id: 1, method: 'ui/initialize', params: { protocolVersion: version, capabilities } }))

  return { bridge, posted, replyTo, send, envelope, handshake, unmount }
}

beforeEach(() => {
  // `activeApp` included: it is module-level state another file may have left
  // set, and these tests assume nothing is open until they open it.
  useMiniAppStore.setState({ activeApp: null, context: null, tools: [], invokeTool: null })
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
    await handshake({}, 99)

    expect(replyTo(1)).toMatchObject({ error: { code: miniAppRpcErrors.unsupportedProtocolVersion } })
    expect(bridge.current?.status).toBe('connecting')
  })

  it('caches a context update for the model to read', async () => {
    const { send, envelope, handshake } = mountBridge()
    await handshake()
    await send(envelope({ method: 'ui/update-model-context', params: { context: { title: 'Q3', summary: '4.2M' } } }))

    expect(useMiniAppStore.getState().context).toEqual({ title: 'Q3', summary: '4.2M' })
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
  it('drops the previous document state when the app handshakes again', async () => {
    const { send, envelope, handshake } = mountBridge()
    await handshake()
    await send(envelope({ method: 'ui/update-model-context', params: { context: { title: 'Q3', summary: '4.2M' } } }))
    useMiniAppStore.getState().setTools([{ name: 'refresh', description: 'Reload the books' }], async () => ({
      content: '',
    }))
    await send(envelope({ method: 'ui/notifications/error', params: { message: 'Chart failed to render' } }))

    await handshake()

    expect(useMiniAppStore.getState().context).toBeNull()
    expect(useMiniAppStore.getState().tools).toEqual([])
  })

  it('clears a runtime error left over from the previous document', async () => {
    const { bridge, send, envelope, handshake } = mountBridge()
    await handshake()
    await send(envelope({ method: 'ui/notifications/error', params: { message: 'Chart failed to render' } }))
    await handshake()

    expect(bridge.current?.runtimeError).toBeNull()
  })

  /*
   * The failure this guards: a frame reloads into a page that never connects, and
   * the host keeps saying `ready` — Select and Chat stay lit over a dead document
   * and every tool call the model makes waits out its full timeout.
   */
  it('goes back to connecting when a new document loads without handshaking', async () => {
    const { bridge, send, envelope, handshake } = mountBridge()
    await handshake()
    await send(envelope({ method: 'ui/update-model-context', params: { context: { title: 'Q3', summary: '4.2M' } } }))
    // The load for the document that just handshaked, then a silent one.
    act(() => bridge.current?.handleFrameLoad())
    act(() => bridge.current?.handleFrameLoad())

    expect(bridge.current?.status).toBe('connecting')
    expect(useMiniAppStore.getState().context).toBeNull()
  })

  it('clears a runtime error when a new document loads without handshaking', async () => {
    const { bridge, send, envelope, handshake } = mountBridge()
    await handshake()
    await send(envelope({ method: 'ui/notifications/error', params: { message: 'Chart failed to render' } }))
    act(() => bridge.current?.handleFrameLoad())
    act(() => bridge.current?.handleFrameLoad())

    expect(bridge.current?.runtimeError).toBeNull()
  })

  // A guest posts `initialize` from its script, which runs before the frame's
  // load event reaches us — so the first load must not undo the handshake.
  it('stays ready through the load event of the document that handshaked', async () => {
    const { bridge, handshake } = mountBridge()
    await handshake()
    act(() => bridge.current?.handleFrameLoad())

    expect(bridge.current?.status).toBe('ready')
  })
})
