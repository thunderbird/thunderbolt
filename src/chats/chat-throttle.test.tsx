/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import type { ThunderboltUIMessage } from '@/types'
import { Chat, useChat } from '@ai-sdk/react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  messageBookkeepingThrottleMs,
  messageRenderThrottleMs,
  smoothStreamWordDelayMs,
  statusOnlyThrottleMs,
} from './chat-throttle'

const assistantMessage = (text: string): ThunderboltUIMessage => ({
  id: 'assistant-1',
  role: 'assistant',
  parts: [{ type: 'text', text }],
})

const lastText = (messages: ThunderboltUIMessage[]): string => {
  const last = messages[messages.length - 1]
  if (!last) {
    return ''
  }
  return last.parts.reduce((acc, part) => (part.type === 'text' ? acc + part.text : acc), '')
}

type ProbeProps = {
  chat: Chat<ThunderboltUIMessage>
  throttleMs?: number
  onRender: () => void
}

/** Renders the current last-message text via `useChat`, counting each commit. */
const StreamProbe = ({ chat, throttleMs, onRender }: ProbeProps) => {
  const { messages } = useChat({ chat, experimental_throttle: throttleMs })
  onRender()
  return <div data-testid="last-text">{lastText(messages)}</div>
}

/**
 * Push `count` growing assistant deltas onto `chat`, advancing the fake clock
 * `stepMs` between each — simulating a token stream at a fixed cadence.
 */
const streamDeltas = async (chat: Chat<ThunderboltUIMessage>, count: number, stepMs: number): Promise<void> => {
  for (let i = 1; i <= count; i++) {
    await act(async () => {
      chat.messages = [assistantMessage('x'.repeat(i))]
      await getClock().tickAsync(stepMs)
    })
  }
}

describe('chat-throttle', () => {
  afterEach(() => {
    cleanup()
  })

  it('exposes coarser intervals for consumers that need less-frequent updates', () => {
    expect(messageRenderThrottleMs).toBeGreaterThan(0)
    expect(messageBookkeepingThrottleMs).toBeGreaterThanOrEqual(messageRenderThrottleMs)
    expect(statusOnlyThrottleMs).toBeGreaterThan(messageBookkeepingThrottleMs)
  })

  it('releases smoothStream words at least as fast as the render cadence so text advances every paint', () => {
    // A fresh word must be ready each render frame; if words arrived slower than
    // the render throttle, some paints would show no growth and streaming would
    // stutter instead of reading as fluid word-by-word typing.
    expect(smoothStreamWordDelayMs).toBeGreaterThan(0)
    expect(smoothStreamWordDelayMs).toBeLessThanOrEqual(messageRenderThrottleMs)
  })

  it('delivers the final complete message after the stream ends (trailing edge, no data loss)', async () => {
    const chat = new Chat<ThunderboltUIMessage>({ messages: [] })
    render(<StreamProbe chat={chat} throttleMs={messageRenderThrottleMs} onRender={() => {}} />)
    expect(screen.getByTestId('last-text').textContent).toBe('')

    // 20 deltas, 10ms apart: several deltas per 100ms throttle window.
    await streamDeltas(chat, 20, 10)
    // Flush the trailing edge so the final coalesced update lands.
    await act(async () => {
      await getClock().tickAsync(messageRenderThrottleMs)
    })

    expect(screen.getByTestId('last-text').textContent).toBe('x'.repeat(20))
  })

  it('coalesces per-token renders relative to an unthrottled subscriber', async () => {
    const deltas = 20
    const stepMs = 10

    let unthrottledRenders = 0
    const unthrottled = new Chat<ThunderboltUIMessage>({ messages: [] })
    render(<StreamProbe chat={unthrottled} onRender={() => (unthrottledRenders += 1)} />)
    const unthrottledBaseline = unthrottledRenders
    await streamDeltas(unthrottled, deltas, stepMs)
    await act(async () => {
      await getClock().tickAsync(messageRenderThrottleMs)
    })
    const unthrottledStreamRenders = unthrottledRenders - unthrottledBaseline
    cleanup()

    let throttledRenders = 0
    const throttled = new Chat<ThunderboltUIMessage>({ messages: [] })
    render(
      <StreamProbe chat={throttled} throttleMs={messageRenderThrottleMs} onRender={() => (throttledRenders += 1)} />,
    )
    const throttledBaseline = throttledRenders
    await streamDeltas(throttled, deltas, stepMs)
    await act(async () => {
      await getClock().tickAsync(messageRenderThrottleMs)
    })
    const throttledStreamRenders = throttledRenders - throttledBaseline

    // Unthrottled re-renders on essentially every delta; throttled collapses the
    // same stream into a handful of commits — while still ending complete.
    expect(unthrottledStreamRenders).toBeGreaterThanOrEqual(deltas - 1)
    expect(throttledStreamRenders).toBeLessThan(unthrottledStreamRenders)
    expect(screen.getByTestId('last-text').textContent).toBe('x'.repeat(deltas))
  })
})
