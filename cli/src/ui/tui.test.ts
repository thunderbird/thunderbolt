/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentHarnessEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import { Container, TUI, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, spyOn, test } from 'bun:test'
import type { HarnessRuntime, ProviderRuntime, ProviderSnapshot } from '../provider-runtime/types.ts'
import { workingStatusText } from './render.ts'
import { assistantMessage, assistantUpdate, MemoryTerminal, rendererEvents } from './test-fixtures.ts'
import { Footer, formatTuiInputEcho, runTuiRepl, subscribeTuiRenderer } from './tui.ts'

test('sanitizes terminal control sequences in the displayed prompt echo', () => {
  const echo = formatTuiInputEcho(' keep\x1b]8;;https://evil.test\x07original\x1b[2J ')

  expect(echo).not.toContain('2J')
  expect(echo).not.toContain('https://evil.test')
})

const providerSnapshot = (): ProviderSnapshot => ({
  revision: 0,
  activeProviderId: 'thunderbolt',
  thunderbolt: {
    status: 'authenticated',
    defaultModelId: 'managed-default',
    models: [{ id: 'managed-default', label: 'Managed default' }],
  },
  providers: [],
})

const providerRuntime = (): ProviderRuntime => ({
  snapshot: providerSnapshot,
  manage: async () => providerSnapshot(),
  prepare: async () => {
    throw new Error('Provider preparation is not used by the TUI test.')
  },
})

const settleTuiSetup = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const tuiHarness = (overrides: Partial<HarnessRuntime> = {}) => {
  let listener: ((event: AgentHarnessEvent) => void) | undefined
  let toolCallGate: Parameters<HarnessRuntime['registerToolCallGate']>[0] | undefined
  let unsubscribes = 0
  const harness: HarnessRuntime = {
    subscribe: (next) => {
      listener = next
      return () => {
        unsubscribes += 1
        listener = undefined
      }
    },
    registerToolCallGate: (gate) => {
      toolCallGate = gate
    },
    steer: async () => {},
    prompt: async () => assistantMessage(),
    abort: async () => {},
    currentProviderId: () => 'thunderbolt',
    switchBinding: async () => {},
    deactivate: async () => {},
    dispose: async () => {},
    ...overrides,
  }
  return {
    harness,
    emit: (event: AgentHarnessEvent) => listener?.(event),
    gate: () => toolCallGate,
    unsubscribes: () => unsubscribes,
  }
}

const runHarnessTui = (terminal: MemoryTerminal, harness: HarnessRuntime): Promise<void> =>
  runTuiRepl(providerRuntime(), {
    connect: async () => ({ harness, model: 'managed-default' }),
    initialPermissionMode: 'yolo',
    fullscreen: false,
    thinking: 'medium',
    terminal,
    applyOutcome: async (outcome, connectedHarness) => {
      if (outcome.kind === 'forward') await connectedHarness.prompt(outcome.text)
      return null
    },
  })

describe('TUI renderer status', () => {
  test('keeps work through protocol starts and clears it on the first real delta', () => {
    const events = rendererEvents()
    const tui = new TUI(new MemoryTerminal())
    const scrollback = new Container()
    const status = new Container()
    spyOn(tui, 'requestRender').mockImplementation(() => {})
    subscribeTuiRenderer(events.runtime, tui, scrollback, status)

    events.emit({ type: 'agent_start' })
    expect(status.render(120).join('\n')).toContain(workingStatusText)

    const message = assistantMessage()
    events.emit({ type: 'message_start', message })
    expect(status.render(120).join('\n')).toContain(workingStatusText)

    const starts: AssistantMessageEvent[] = [
      { type: 'start', partial: message },
      { type: 'text_start', contentIndex: 0, partial: message },
      { type: 'thinking_start', contentIndex: 1, partial: message },
      { type: 'toolcall_start', contentIndex: 2, partial: message },
    ]
    for (const start of starts) events.emit(assistantUpdate(message, start))
    expect(status.children).not.toEqual([])
    expect(status.render(120).join('\n')).toContain('Reasoning')

    events.emit(
      assistantUpdate(message, { type: 'thinking_delta', contentIndex: 1, delta: 'answer', partial: message }),
    )
    expect(status.children).toEqual([])
  })

  test('clears work before tool activity is rendered', () => {
    const events = rendererEvents()
    const tui = new TUI(new MemoryTerminal())
    const status = new Container()
    spyOn(tui, 'requestRender').mockImplementation(() => {})
    subscribeTuiRenderer(events.runtime, tui, new Container(), status)
    events.emit({ type: 'agent_start' })

    events.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'a.ts' } })

    expect(status.children).toEqual([])
  })

  test('clears work on completion, abort, and error before any delta', () => {
    const terminalEvents: AgentHarnessEvent[] = [
      { type: 'message_end', message: assistantMessage() },
      { type: 'agent_end', messages: [] },
      { type: 'abort', clearedSteer: [], clearedFollowUp: [] },
      { type: 'turn_end', message: assistantMessage('error'), toolResults: [] },
    ]

    for (const terminalEvent of terminalEvents) {
      const events = rendererEvents()
      const tui = new TUI(new MemoryTerminal())
      const status = new Container()
      spyOn(tui, 'requestRender').mockImplementation(() => {})
      subscribeTuiRenderer(events.runtime, tui, new Container(), status)
      events.emit({ type: 'agent_start' })

      events.emit(terminalEvent)

      expect(status.children).toEqual([])
    }
  })
})

describe('Footer', () => {
  test('composes identity and contextual hints on one wide line', () => {
    const footer = new Footer(
      { model: 'GLM 5.2', confidential: true, thinking: 'medium', permissionMode: 'ask' },
      () => 'idle',
    )
    const lines = footer.render(100)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('GLM 5.2')
    expect(lines[0]).toContain('confidential')
    expect(lines[0]).toContain('thinking med')
    expect(lines[0]).toContain('permissions ask')
    expect(lines[0]).toContain('/ commands')
    expect(visibleWidth(lines[0]!)).toBe(100)
  })

  test('truncates identity and collapses to the essential narrow hint', () => {
    const footer = new Footer(
      {
        model: 'A model name much longer than the terminal',
        confidential: true,
        thinking: 'xhigh',
        permissionMode: 'ask',
      },
      () => 'active',
    )
    const line = footer.render(32)[0] ?? ''

    expect(line).toContain('enter queue')
    expect(line).toContain('esc interrupt')
    expect(visibleWidth(line)).toBe(32)
  })
})

describe('runTuiRepl', () => {
  const connectItems = [
    { id: 'account-choice', label: 'account-choice' },
    { id: 'byok-choice', label: 'byok-choice' },
  ] as const

  test('Enter during an active turn queues and renders the submitted text', async () => {
    const terminal = new MemoryTerminal()
    const promptStarted = Promise.withResolvers<void>()
    const promptFinished = Promise.withResolvers<void>()
    const events = tuiHarness({
      prompt: async () => {
        promptStarted.resolve()
        await promptFinished.promise
        return assistantMessage()
      },
    })
    const running = runHarnessTui(terminal, events.harness)
    await settleTuiSetup()

    terminal.send('first prompt')
    terminal.send('\r')
    await promptStarted.promise
    terminal.send('queued prompt')
    terminal.send('\r')
    await terminal.waitForOutput('Queued (1)')

    expect(terminal.writes.join('')).toContain('Queued (1)')
    expect(terminal.writes.join('')).toContain('1. queued prompt')

    promptFinished.resolve()
    await settleTuiSetup()
    terminal.send('\x04')
    await running
  })

  test('agent_end submits the first queued item through the normal input path', async () => {
    const terminal = new MemoryTerminal()
    const firstPromptFinished = Promise.withResolvers<void>()
    const secondPromptStarted = Promise.withResolvers<void>()
    const prompts: string[] = []
    const events = tuiHarness({
      prompt: async (text) => {
        prompts.push(text)
        if (prompts.length === 1) await firstPromptFinished.promise
        if (prompts.length === 2) secondPromptStarted.resolve()
        return assistantMessage()
      },
    })
    const running = runHarnessTui(terminal, events.harness)
    await settleTuiSetup()

    terminal.send('first prompt')
    terminal.send('\r')
    await settleTuiSetup()
    terminal.send('queued first')
    terminal.send('\r')
    terminal.send('queued second')
    terminal.send('\r')
    await settleTuiSetup()
    terminal.writes.length = 0

    events.emit({ type: 'agent_end', messages: [] })
    firstPromptFinished.resolve()
    await secondPromptStarted.promise
    await terminal.waitForOutput('Queued (1)')

    expect(prompts).toEqual(['first prompt', 'queued first'])
    expect(terminal.writes.join('')).toContain('Queued (1)')
    expect(terminal.writes.join('')).toContain('1. queued second')
    expect(terminal.writes.join('')).toContain(formatTuiInputEcho('queued first'))

    terminal.send('\x04')
    await running
  })

  test('Up focuses the queue and Enter steers the active turn with the selected item', async () => {
    const terminal = new MemoryTerminal()
    const promptStarted = Promise.withResolvers<void>()
    const promptFinished = Promise.withResolvers<void>()
    const steered: string[] = []
    const events = tuiHarness({
      prompt: async () => {
        promptStarted.resolve()
        await promptFinished.promise
        return assistantMessage()
      },
      steer: async (text) => {
        steered.push(text)
      },
    })
    const running = runHarnessTui(terminal, events.harness)
    await settleTuiSetup()

    terminal.send('first prompt')
    terminal.send('\r')
    await promptStarted.promise
    terminal.send('steer this')
    terminal.send('\r')
    terminal.send('leave queued')
    terminal.send('\r')
    terminal.send('draft stays')
    terminal.writes.length = 0
    terminal.send('\x1b[A')
    await terminal.waitForOutput('Queued (2)')

    const output = terminal.writes.join('')
    expect(output).toContain('> 1. steer this')
    expect(output).not.toContain('> 2. leave queued')

    terminal.send('\r')
    await terminal.waitForOutput('steering')

    expect(steered).toEqual(['steer this'])
    expect(terminal.writes.join('')).toContain('steering')

    promptFinished.resolve()
    await settleTuiSetup()
    terminal.send('\x04')
    await running
  })

  test('Backspace removes the selected queued item', async () => {
    const terminal = new MemoryTerminal()
    const promptStarted = Promise.withResolvers<void>()
    const promptFinished = Promise.withResolvers<void>()
    const events = tuiHarness({
      prompt: async () => {
        promptStarted.resolve()
        await promptFinished.promise
        return assistantMessage()
      },
    })
    const running = runHarnessTui(terminal, events.harness)
    await settleTuiSetup()

    terminal.send('first prompt')
    terminal.send('\r')
    await promptStarted.promise
    terminal.send('remove me')
    terminal.send('\r')
    terminal.send('keep me')
    terminal.send('\r')
    terminal.send('\x1b[A')
    terminal.writes.length = 0
    terminal.send('\x7f')
    await terminal.waitForOutput('Queued (1)')

    expect(terminal.writes.join('')).toContain('Queued (1)')
    expect(terminal.writes.join('')).toContain('1. keep me')
    expect(terminal.writes.join('')).not.toContain('1. remove me')

    promptFinished.resolve()
    await settleTuiSetup()
    terminal.send('\x04')
    await running
  })

  test('Escape aborts the active turn and keeps queued text until explicitly sent', async () => {
    const terminal = new MemoryTerminal()
    const firstPromptStarted = Promise.withResolvers<void>()
    const firstPromptFinished = Promise.withResolvers<void>()
    const queuedPromptStarted = Promise.withResolvers<void>()
    const prompts: string[] = []
    let abortCalls = 0
    const events = tuiHarness({
      prompt: async (text) => {
        prompts.push(text)
        if (prompts.length === 1) {
          firstPromptStarted.resolve()
          await firstPromptFinished.promise
        } else {
          queuedPromptStarted.resolve()
        }
        return assistantMessage()
      },
      abort: async () => {
        abortCalls += 1
        firstPromptFinished.resolve()
      },
    })
    const running = runHarnessTui(terminal, events.harness)
    await settleTuiSetup()

    terminal.send('first prompt')
    terminal.send('\r')
    await firstPromptStarted.promise
    terminal.send('kept prompt')
    terminal.send('\r')
    terminal.send('\x1b')
    await settleTuiSetup()

    expect(abortCalls).toBe(1)
    expect(prompts).toEqual(['first prompt'])
    terminal.send('\x1b[A')
    terminal.send('\r')
    await queuedPromptStarted.promise
    expect(prompts).toEqual(['first prompt', 'kept prompt'])

    terminal.send('\x04')
    await running
  })

  test('send now keeps a queued item when the active turn was just aborted', async () => {
    const terminal = new MemoryTerminal()
    const firstPromptStarted = Promise.withResolvers<void>()
    const firstPromptFinished = Promise.withResolvers<void>()
    const queuedPromptStarted = Promise.withResolvers<string>()
    const prompts: string[] = []
    const steered: string[] = []
    const events = tuiHarness({
      prompt: async (text) => {
        prompts.push(text)
        if (prompts.length === 1) {
          firstPromptStarted.resolve()
          await firstPromptFinished.promise
        } else {
          queuedPromptStarted.resolve(text)
        }
        return assistantMessage()
      },
      abort: async () => {
        firstPromptFinished.resolve()
      },
      steer: async (text) => {
        steered.push(text)
      },
    })
    const running = runHarnessTui(terminal, events.harness)
    await settleTuiSetup()

    terminal.send('first prompt')
    terminal.send('\r')
    await firstPromptStarted.promise
    terminal.send('kept prompt')
    terminal.send('\r')
    terminal.send('\x1b')
    terminal.send('\x1b[A')
    terminal.send('\r')
    await settleTuiSetup()
    terminal.send('\r')
    const queuedPrompt = await queuedPromptStarted.promise

    terminal.send('\x04')
    await running

    expect(steered).toEqual([])
    expect(queuedPrompt).toBe('kept prompt')
  })

  test('send now keeps a queued item and renders a steering failure', async () => {
    const terminal = new MemoryTerminal()
    const promptStarted = Promise.withResolvers<void>()
    const promptFinished = Promise.withResolvers<void>()
    const events = tuiHarness({
      prompt: async () => {
        promptStarted.resolve()
        await promptFinished.promise
        return assistantMessage()
      },
      steer: async () => {
        throw new Error('steer failed')
      },
    })
    const running = runHarnessTui(terminal, events.harness)
    await settleTuiSetup()

    terminal.send('first prompt')
    terminal.send('\r')
    await promptStarted.promise
    terminal.send('keep after failure')
    terminal.send('\r')
    terminal.send('\x1b[A')
    terminal.writes.length = 0
    terminal.send('\r')
    await terminal.waitForOutput('steer failed')
    const output = terminal.writes.join('')

    promptFinished.resolve()
    await settleTuiSetup()
    terminal.send('\x04')
    await running

    expect(output).toContain('Queued (1)')
    expect(output).toContain('1. keep after failure')
    expect(output).toContain('steer failed')
    expect(output).not.toContain('[steering]')
  })

  test('runs provider selection before harness creation, then enables the connected editor and footer', async () => {
    const terminal = new MemoryTerminal()
    const pickerReady = Promise.withResolvers<void>()
    const selected = Promise.withResolvers<string | null>()
    const connected = Promise.withResolvers<void>()
    const prompted = Promise.withResolvers<string>()
    let harnessCreated = false
    const model = providerSnapshot().thunderbolt.models?.[0]
    if (model === undefined) throw new Error('The TUI test requires a managed model.')

    const running = runTuiRepl(providerRuntime(), {
      connect: async (io) => {
        const choice = io.choose('First run', connectItems)
        pickerReady.resolve()
        selected.resolve(await choice)
        const events = tuiHarness({
          prompt: async (text) => {
            prompted.resolve(text)
            return assistantMessage()
          },
        })
        harnessCreated = true
        connected.resolve()
        return { harness: events.harness, model: model.id }
      },
      initialPermissionMode: 'yolo',
      fullscreen: false,
      thinking: 'medium',
      terminal,
      applyOutcome: async (outcome, harness) => {
        if (outcome.kind === 'forward') await harness.prompt(outcome.text)
        return null
      },
    })

    await pickerReady.promise
    await settleTuiSetup()
    expect(harnessCreated).toBeFalse()
    expect(terminal.writes.join('')).toContain(connectItems[0].id)
    expect(terminal.writes.join('')).toContain(connectItems[1].id)

    terminal.send('\r')
    await expect(selected.promise).resolves.toBe(connectItems[0].id)
    await connected.promise
    await settleTuiSetup()
    expect(terminal.writes.join('')).toContain(model.label)
    terminal.send('hello')
    terminal.send('\r')
    await expect(prompted.promise).resolves.toBe('hello')

    terminal.send('\x04')
    await running
  })

  test('Escape and Ctrl+C abort provider connection, tear down the TUI, and preserve the cancellation error', async () => {
    for (const input of ['\x1b', '\x03']) {
      const terminal = new MemoryTerminal()
      const pickerReady = Promise.withResolvers<void>()
      const events = tuiHarness()
      const cancellationMessage = 'Provider setup was cancelled before a provider was selected.'
      const running = runTuiRepl(providerRuntime(), {
        connect: async (io, signal) => {
          const choice = io.choose('First run', connectItems)
          pickerReady.resolve()
          await choice
          expect(signal.reason).toMatchObject({ message: cancellationMessage })
          return { harness: events.harness, model: 'managed-default' }
        },
        initialPermissionMode: 'yolo',
        fullscreen: false,
        thinking: 'medium',
        terminal,
        applyOutcome: async () => null,
      })

      await pickerReady.promise
      terminal.send(input)

      await expect(running).rejects.toThrow(cancellationMessage)
      expect(events.unsubscribes()).toBe(0)
      expect(terminal.stopCount).toBe(1)
    }
  })

  test('defaults to the main buffer, clears the screen, and tears down its renderer', async () => {
    const terminal = new MemoryTerminal()
    const events = tuiHarness()
    const running = runTuiRepl(providerRuntime(), {
      connect: async () => ({ harness: events.harness, model: 'managed-default' }),
      initialPermissionMode: 'yolo',
      fullscreen: false,
      thinking: 'medium',
      terminal,
      applyOutcome: async () => null,
    })
    await settleTuiSetup()
    events.emit({ type: 'agent_start' })
    terminal.send('\x04')

    await running

    expect(terminal.writes).toContain('\x1b[2J\x1b[H')
    expect(terminal.writes.some((write) => write.includes('1049'))).toBeFalse()
    expect(events.unsubscribes()).toBe(1)
  })

  test('fullscreen owns the alternate screen for the TUI lifetime', async () => {
    const terminal = new MemoryTerminal()
    const events = tuiHarness()
    const running = runTuiRepl(providerRuntime(), {
      connect: async () => ({ harness: events.harness, model: 'managed-default' }),
      initialPermissionMode: 'yolo',
      fullscreen: true,
      thinking: 'medium',
      terminal,
      applyOutcome: async () => null,
    })
    await settleTuiSetup()
    terminal.send('\x04')

    await running

    expect(terminal.writes.filter((write) => write.includes('1049'))).toEqual([
      '\x1b[?1049h\x1b[2J\x1b[H',
      '\x1b[?1049l',
    ])
  })

  test('Escape cancels a pending permission prompt without exiting the TUI', async () => {
    const terminal = new MemoryTerminal()
    const events = tuiHarness()
    const gateStarted = Promise.withResolvers<void>()
    let gateResult: ReturnType<NonNullable<ReturnType<typeof events.gate>>> | undefined
    const running = runTuiRepl(providerRuntime(), {
      connect: async () => ({ harness: events.harness, model: 'managed-default' }),
      initialPermissionMode: 'ask',
      fullscreen: false,
      thinking: 'medium',
      terminal,
      applyOutcome: async () => {
        const gate = events.gate()
        if (!gate) throw new Error('Permission gate was not installed.')
        gateResult = gate({ type: 'tool_call', toolCallId: 'tool-1', toolName: 'bash', input: { command: 'pwd' } })
        gateStarted.resolve()
        await gateResult
        return null
      },
    })
    await settleTuiSetup()
    terminal.send('run a tool')
    terminal.send('\r')
    await gateStarted.promise

    terminal.send('\x1b')
    await expect(gateResult).resolves.toEqual({ block: true, reason: 'User denied bash' })

    terminal.send('\x04')
    await running
  })

  test('first Ctrl+C arms the footer and the second exits', async () => {
    const terminal = new MemoryTerminal()
    const events = tuiHarness()
    const running = runTuiRepl(providerRuntime(), {
      connect: async () => ({ harness: events.harness, model: 'managed-default' }),
      initialPermissionMode: 'yolo',
      fullscreen: false,
      thinking: 'medium',
      terminal,
      applyOutcome: async () => null,
    })
    await settleTuiSetup()

    terminal.send('\x03')
    await Promise.resolve()
    expect(events.unsubscribes()).toBe(0)
    terminal.send('\x03')

    await running
  })

  test.each([
    ['legacy BackTab', ['\x1b[Z']],
    ['Kitty Shift+Tab press', ['\x1b[9;2u']],
    ['Kitty Shift+Tab press and release', ['\x1b[9;2u', '\x1b[9;2:3u']],
    ['Kitty Shift+Tab press, repeat, and release', ['\x1b[9;2u', '\x1b[9;2:2u', '\x1b[9;2:3u']],
  ])('%s advances the permission mode exactly once', async (_label, input) => {
    const terminal = new MemoryTerminal()
    const events = tuiHarness()
    const gateResult = Promise.withResolvers<unknown>()
    const running = runTuiRepl(providerRuntime(), {
      connect: async () => ({ harness: events.harness, model: 'managed-default' }),
      initialPermissionMode: 'ask',
      fullscreen: false,
      thinking: 'medium',
      terminal,
      applyOutcome: async () => {
        const gate = events.gate()
        if (!gate) throw new Error('Permission gate was not installed.')
        gateResult.resolve(
          await gate({ type: 'tool_call', toolCallId: 'tool-1', toolName: 'write', input: { path: 'a.ts' } }),
        )
        return null
      },
    })
    await settleTuiSetup()

    for (const data of input) terminal.send(data)
    terminal.send('edit a file')
    terminal.send('\r')
    await expect(gateResult.promise).resolves.toBeUndefined()
    terminal.send('\x04')
    await running
  })

  test('/permissions opens a SelectList with every mode and applies its selection', async () => {
    const terminal = new MemoryTerminal()
    const events = tuiHarness()
    const permissionApplied = Promise.withResolvers<void>()
    const gateResult = Promise.withResolvers<unknown>()
    let applyCount = 0
    const running = runTuiRepl(providerRuntime(), {
      connect: async () => ({ harness: events.harness, model: 'managed-default' }),
      initialPermissionMode: 'ask',
      fullscreen: false,
      thinking: 'medium',
      terminal,
      applyOutcome: async () => {
        applyCount += 1
        if (applyCount === 1) {
          permissionApplied.resolve()
          return null
        }
        const gate = events.gate()
        if (!gate) throw new Error('Permission gate was not installed.')
        gateResult.resolve(
          await gate({ type: 'tool_call', toolCallId: 'tool-1', toolName: 'bash', input: { command: 'pwd' } }),
        )
        return null
      },
    })
    await settleTuiSetup()
    terminal.send('/permissions')
    terminal.send('\r')
    await Promise.resolve()

    terminal.send('\x1b[B')
    terminal.send('\x1b[B')
    terminal.send('\r')
    await permissionApplied.promise
    await Promise.resolve()

    terminal.send('run a command')
    terminal.send('\r')
    await expect(gateResult.promise).resolves.toEqual({ block: true, reason: expect.stringContaining('read-only') })

    terminal.send('\x04')
    await running
  })
})
