/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The approval gate. Every promise here is holding a model turn open, so the
 * property under test throughout is "it always settles" — a prompt nobody
 * answers, an app that closes underneath one, a second request arriving behind
 * the first. A leak in any of those is a spinner with no explanation.
 */

import { getClock } from '@/testing-library'
import type { MiniAppTool } from '@shared/mini-app-protocol'
import { beforeEach, describe, expect, it } from 'bun:test'

import type { MiniAppDefinition } from './registry'
import { useMiniAppStore } from './mini-app-store'

const app = { id: 'finance-model', name: 'Finance Model' } as MiniAppDefinition

const writeTool = {
  name: 'set_assumption',
  description: 'Change one assumption.',
  inputSchema: { type: 'object' },
} as MiniAppTool

const store = () => useMiniAppStore.getState()

beforeEach(() => {
  useMiniAppStore.setState({
    activeApp: null,
    context: null,
    tools: [],
    invokeTool: null,
    approvalQueue: [],
  })
})

describe('requestApproval', () => {
  it('denies immediately when no app is open, rather than hanging', async () => {
    expect(await store().requestApproval(writeTool, {})).toBe(false)
  })

  it('surfaces the prompt and resolves with the decision', async () => {
    store().openApp(app)
    const decision = store().requestApproval(writeTool, { growth: 0.2 })

    expect(store().approvalQueue[0]?.tool.name).toBe('set_assumption')
    store().resolveApproval(true)

    expect(await decision).toBe(true)
  })

  it('resolves false when denied', async () => {
    store().openApp(app)
    const decision = store().requestApproval(writeTool, {})
    store().resolveApproval(false)

    expect(await decision).toBe(false)
  })

  /** A second prompt behind the first would be invisible, so it supersedes —
   *  but the superseded turn still has to be told something. */
  /*
   * The AI SDK runs a step's tool calls concurrently, so a model emitting two
   * writes in one response used to have the first auto-denied before the user
   * saw it — and was told the user had declined.
   */
  it('queues a second request behind the first instead of denying it', async () => {
    store().openApp(app)
    const first = store().requestApproval(writeTool, { n: 1 })
    const second = store().requestApproval(writeTool, { n: 2 })

    expect(store().approvalQueue).toHaveLength(2)
    expect(store().approvalQueue[0]?.args).toEqual({ n: 1 })

    store().resolveApproval(true)
    expect(await first).toBe(true)

    // Answering the first promotes the second rather than settling both.
    expect(store().approvalQueue[0]?.args).toEqual({ n: 2 })
    store().resolveApproval(false)
    expect(await second).toBe(false)
  })

  it('denies everything still queued when the app closes', async () => {
    store().openApp(app)
    const first = store().requestApproval(writeTool, { n: 1 })
    const second = store().requestApproval(writeTool, { n: 2 })

    store().closeApp()

    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect(store().approvalQueue).toEqual([])
  })

  /** The app the call would have acted on is gone; leaving it pending would
   *  hang the turn on a prompt nobody can answer. */
  it('denies an outstanding request when the app closes', async () => {
    store().openApp(app)
    const decision = store().requestApproval(writeTool, {})
    store().closeApp()

    expect(await decision).toBe(false)
    expect(store().approvalQueue[0] ?? null).toBeNull()
  })

  /**
   * The reason this has a deadline at all: the promise is holding the model's
   * streaming request open, so a prompt the user walks away from doesn't just
   * sit there — it wedges the turn behind a spinner with no explanation.
   */
  it('denies itself if nobody ever answers', async () => {
    store().openApp(app)
    const decision = store().requestApproval(writeTool, {})

    await getClock().runAllAsync()

    expect(await decision).toBe(false)
    expect(store().approvalQueue[0] ?? null).toBeNull()
  })

  /**
   * The case `clearTimeout` actually protects, and the reason it isn't just
   * tidiness: an answered prompt's timer, left running, fires 120s later and
   * calls `decide(false)` on whatever is pending *then* — denying a later,
   * unrelated request the user never saw.
   */
  it('does not let an answered prompt time out a later one', async () => {
    store().openApp(app)
    const first = store().requestApproval(writeTool, { n: 1 })
    store().resolveApproval(true)
    expect(await first).toBe(true)

    // The second request has to arrive *later*, or both deadlines land on the
    // same virtual instant and the test proves nothing.
    await getClock().tickAsync(60_000)
    const second = store().requestApproval(writeTool, { n: 2 })

    // Past the first prompt's deadline, well short of the second's.
    await getClock().tickAsync(70_000)

    expect(store().approvalQueue[0]?.args).toEqual({ n: 2 })
    store().resolveApproval(true)
    expect(await second).toBe(true)
  })

  it('does not deny after the user already approved', async () => {
    store().openApp(app)
    const decision = store().requestApproval(writeTool, {})
    store().resolveApproval(true)

    await getClock().runAllAsync()

    expect(await decision).toBe(true)
  })
})
