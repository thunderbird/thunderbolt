/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentHarnessEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import type { Terminal } from '@earendil-works/pi-tui'

export class MemoryTerminal implements Terminal {
  readonly writes: string[] = []
  readonly columns = 120
  readonly rows = 40
  readonly kittyProtocolActive = false
  stopCount = 0
  private onInput!: (data: string) => void
  private readonly outputListeners = new Set<() => void>()

  start(onInput: (data: string) => void): void {
    this.onInput = onInput
  }
  stop(): void {
    this.stopCount += 1
  }
  drainInput(): Promise<void> {
    return Promise.resolve()
  }
  write(data: string): void {
    this.writes.push(data)
    for (const listener of this.outputListeners) listener()
  }
  waitForOutput(text: string): Promise<void> {
    if (this.writes.join('').includes(text)) return Promise.resolve()
    const completion = Promise.withResolvers<void>()
    const listener = (): void => {
      if (!this.writes.join('').includes(text)) return
      this.outputListeners.delete(listener)
      completion.resolve()
    }
    this.outputListeners.add(listener)
    return completion.promise
  }
  send(data: string): void {
    this.onInput(data)
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

/** Creates a minimal assistant message for UI tests. */
export const assistantMessage = (stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: 'openai-completions',
  provider: 'test-provider',
  model: 'test-model',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 0,
})

/** Wraps an assistant stream update in the harness event shape used by UI tests. */
export const assistantUpdate = (
  message: AssistantMessage,
  assistantMessageEvent: AssistantMessageEvent,
): AgentHarnessEvent => ({ type: 'message_update', message, assistantMessageEvent })

/** Captures renderer subscription events. */
export const rendererEvents = (providerId = 'thunderbolt') => {
  let listener: ((event: AgentHarnessEvent) => void) | undefined
  return {
    runtime: {
      currentProviderId: () => providerId,
      subscribe: (next: (event: AgentHarnessEvent) => void) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
    },
    emit: (event: AgentHarnessEvent) => listener?.(event),
  }
}
