/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The approval gate. Every promise here is holding a model turn open, so the
 * property under test throughout is "it always settles" — a prompt nobody
 * answers, an app that closes underneath one, a second request arriving behind
 * the first. A leak in any of those is a spinner with no explanation.
 *
 * The second property, since the queue moved onto the chat session: an answer
 * lands on the request it was given for. Not the head of a shared queue, which
 * is what let a double-click approve the next, unseen call — and let one chat's
 * prompt appear over another chat after a switch.
 */

import { useChatStore, type ChatSession } from '@/chats/chat-store'
import { builtInAgent } from '@/defaults/agents'
import { getClock } from '@/testing-library'
import type { Model } from '@/types'
import type { MiniAppTool } from '@shared/mini-app-protocol'
import { beforeEach, describe, expect, it } from 'bun:test'

import { requestMiniAppApproval } from './mini-app-approval'
import { useMiniAppStore } from './mini-app-store'
import type { MiniAppDefinition } from './registry'

const app = { id: 'finance-model', name: 'Finance Model' } as MiniAppDefinition
const otherApp = { id: 'patient-journeys', name: 'Patient Journeys' } as MiniAppDefinition

const writeTool = {
  name: 'set_assumption',
  description: 'Change one assumption.',
  inputSchema: { type: 'object' },
} as MiniAppTool

/** Only the fields the approval path reads; the rest of a session is inert here. */
const makeSession = (id: string): ChatSession =>
  ({
    // Never touched by the approval path — it reads only the queue.
    chatInstance: {} as ChatSession['chatInstance'],
    chatThread: null,
    connectionStatus: 'idle',
    connectionError: null,
    id,
    pendingPermission: null,
    miniAppApprovalQueue: [],
    retryCount: 0,
    retriesExhausted: false,
    selectedAgent: builtInAgent,
    selectedModel: { id: 'model-1' } as Model,
    projectId: null,
    miniAppId: app.id,
    triggerData: null,
  }) as ChatSession

const queueOf = (id: string) => useChatStore.getState().sessions.get(id)?.miniAppApprovalQueue ?? []

const ask = (chatThreadId: string, args: unknown, forApp = app) =>
  requestMiniAppApproval({ chatThreadId, app: forApp, tool: writeTool, args })

beforeEach(() => {
  useMiniAppStore.setState({ activeApp: app, context: null, tools: [], invokeTool: null })
  useChatStore.setState({
    sessions: new Map([
      ['chat-a', makeSession('chat-a')],
      ['chat-b', makeSession('chat-b')],
    ]),
    currentSessionId: 'chat-a',
  })
})

describe('requestMiniAppApproval', () => {
  it('denies immediately when the chat has no live session, rather than hanging', async () => {
    expect(await ask('closed-tab', {})).toBe(false)
  })

  it('surfaces the prompt on the asking chat and resolves with the decision', async () => {
    const decision = ask('chat-a', { growth: 0.2 })

    expect(queueOf('chat-a')[0]?.tool.name).toBe('set_assumption')
    queueOf('chat-a')[0]?.decide(true)

    expect(await decision).toBe(true)
  })

  it('resolves false when denied', async () => {
    const decision = ask('chat-a', {})
    queueOf('chat-a')[0]?.decide(false)

    expect(await decision).toBe(false)
  })

  /**
   * The bug this ownership move exists to fix: held globally, a request made in
   * one chat was on screen in whichever chat the user switched to, and the
   * answer went to the head of a queue shared by both.
   */
  it('keeps one chat’s approval out of another chat', async () => {
    const decision = ask('chat-a', { n: 1 })

    expect(queueOf('chat-a')).toHaveLength(1)
    expect(queueOf('chat-b')).toEqual([])

    queueOf('chat-a')[0]?.decide(true)
    expect(await decision).toBe(true)
  })

  it('lets two chats hold their own approvals at once', async () => {
    const first = ask('chat-a', { n: 1 })
    const second = ask('chat-b', { n: 2 })

    queueOf('chat-b')[0]?.decide(true)
    expect(await second).toBe(true)
    // Answering one chat's prompt leaves the other's exactly where it was.
    expect(queueOf('chat-a')[0]?.args).toEqual({ n: 1 })

    queueOf('chat-a')[0]?.decide(false)
    expect(await first).toBe(false)
  })

  /*
   * The AI SDK runs a step's tool calls concurrently, so a model emitting two
   * writes in one response used to have the first auto-denied before the user
   * saw it — and was told the user had declined.
   */
  it('queues a second request behind the first instead of denying it', async () => {
    const first = ask('chat-a', { n: 1 })
    const second = ask('chat-a', { n: 2 })

    expect(queueOf('chat-a')).toHaveLength(2)
    expect(queueOf('chat-a')[0]?.args).toEqual({ n: 1 })

    queueOf('chat-a')[0]?.decide(true)
    expect(await first).toBe(true)

    // Answering the first promotes the second rather than settling both.
    expect(queueOf('chat-a')[0]?.args).toEqual({ n: 2 })
    queueOf('chat-a')[0]?.decide(false)
    expect(await second).toBe(false)
  })

  /**
   * Double-click. The prompt hands `decide` for the entry it rendered, so the
   * second click answers a request that is already settled and is dropped —
   * where resolving "the head" approved whatever had just moved into view.
   */
  it('does not let a second click answer the next, unseen request', async () => {
    const first = ask('chat-a', { n: 1 })
    const second = ask('chat-a', { n: 2 })
    const onScreen = queueOf('chat-a')[0]

    onScreen?.decide(true)
    onScreen?.decide(true)

    expect(await first).toBe(true)
    // Still waiting to be read, not approved by a stray click.
    expect(queueOf('chat-a')[0]?.args).toEqual({ n: 2 })

    queueOf('chat-a')[0]?.decide(false)
    expect(await second).toBe(false)
  })

  /** Same shape, from the other direction: the click lands after the deadline
   *  already denied the request it was for. */
  it('drops a click that lost the race with its own deadline', async () => {
    const first = ask('chat-a', { n: 1 })
    const onScreen = queueOf('chat-a')[0]

    await getClock().runAllAsync()
    expect(await first).toBe(false)

    const second = ask('chat-a', { n: 2 })
    onScreen?.decide(true)

    expect(queueOf('chat-a')[0]?.args).toEqual({ n: 2 })
    queueOf('chat-a')[0]?.decide(false)
    expect(await second).toBe(false)
  })

  it('denies everything still queued when the app closes', async () => {
    const first = ask('chat-a', { n: 1 })
    const second = ask('chat-a', { n: 2 })

    useMiniAppStore.getState().closeApp()

    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect(queueOf('chat-a')).toEqual([])
  })

  /** The sweep reaches every chat, not just the one on screen: the app those
   *  calls would have acted on is gone from all of them. */
  it('denies queued approvals in chats the user is not looking at', async () => {
    const background = ask('chat-b', { n: 1 })

    useMiniAppStore.getState().closeApp()

    expect(await background).toBe(false)
    expect(queueOf('chat-b')).toEqual([])
  })

  /** A re-handshake replaces the document behind the frame, so its pending
   *  calls describe a page that no longer exists. */
  it('denies queued approvals when the guest re-handshakes', async () => {
    const decision = ask('chat-a', {})

    useMiniAppStore.getState().resetGuest()

    expect(await decision).toBe(false)
  })

  /** Keyed by app, so closing one app cannot answer a call another app is
   *  waiting on. */
  it('leaves another app’s approvals alone', async () => {
    const other = ask('chat-a', {}, otherApp)

    useMiniAppStore.getState().closeApp()

    expect(queueOf('chat-a')).toHaveLength(1)
    queueOf('chat-a')[0]?.decide(true)
    expect(await other).toBe(true)
  })

  /**
   * The reason this has a deadline at all: the promise is holding the model's
   * streaming request open, so a prompt the user walks away from doesn't just
   * sit there — it wedges the turn behind a spinner with no explanation.
   */
  it('denies itself if nobody ever answers', async () => {
    const decision = ask('chat-a', {})

    await getClock().runAllAsync()

    expect(await decision).toBe(false)
    expect(queueOf('chat-a')).toEqual([])
  })

  /**
   * The case `clearTimeout` actually protects, and the reason it isn't just
   * tidiness: an answered prompt's timer, left running, fires 120s later and
   * calls `decide(false)` on whatever is pending *then* — denying a later,
   * unrelated request the user never saw.
   */
  it('does not let an answered prompt time out a later one', async () => {
    const first = ask('chat-a', { n: 1 })
    queueOf('chat-a')[0]?.decide(true)
    expect(await first).toBe(true)

    // The second request has to arrive *later*, or both deadlines land on the
    // same virtual instant and the test proves nothing.
    await getClock().tickAsync(60_000)
    const second = ask('chat-a', { n: 2 })

    // Past the first prompt's deadline, well short of the second's.
    await getClock().tickAsync(70_000)

    expect(queueOf('chat-a')[0]?.args).toEqual({ n: 2 })
    queueOf('chat-a')[0]?.decide(true)
    expect(await second).toBe(true)
  })

  it('does not deny after the user already approved', async () => {
    const decision = ask('chat-a', {})
    queueOf('chat-a')[0]?.decide(true)

    await getClock().runAllAsync()

    expect(await decision).toBe(true)
  })
})
