/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Coverage for the interactive tool-permission gate. The gate is the security
 * boundary between the model and the host's write/edit/bash tools, so every
 * branch matters: yolo bypass, read-only passthrough, the three decision
 * outcomes, session-allow memory scoping, and the human summary builder. The
 * runtime is faked down to `registerToolCallGate`; we invoke the captured
 * handler directly with no real agent loop.
 */

import { describe, expect, test } from 'bun:test'
import {
  attachPermissionGate,
  cyclePermissionMode,
  readOnlyBlockReason,
  type PermissionMode,
} from './permissions.ts'
import type { HarnessRuntime } from '../provider-runtime/types.ts'
import type { PermissionDecision, PermissionPrompt, PermissionRequest } from './types.ts'

type ToolCall = { type: 'tool_call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
/** A fake runtime exposing only the gate seam, capturing its handler. */
const fakeHarness = () => {
  let handler: Parameters<HarnessRuntime['registerToolCallGate']>[0] | null = null
  const harness: Pick<HarnessRuntime, 'registerToolCallGate'> = {
    registerToolCallGate: (candidate) => {
      handler = candidate
    },
  }
  return { harness, getHandler: () => handler }
}

/** A prompt stub that always answers `decision` and records every request. */
const constantAsk = (decision: PermissionDecision) => {
  const seen: PermissionRequest[] = []
  const ask: PermissionPrompt = async (request) => {
    seen.push(request)
    return decision
  }
  return { ask, seen }
}

const call = (toolName: string, input: Record<string, unknown> = {}): ToolCall => ({
  type: 'tool_call',
  toolCallId: 't',
  toolName,
  input,
})

test('attachPermissionGate accepts the narrow HarnessRuntime gate surface', async () => {
  let handler: Parameters<HarnessRuntime['registerToolCallGate']>[0] | null = null
  const target: Pick<HarnessRuntime, 'registerToolCallGate'> = {
    registerToolCallGate: (candidate) => {
      handler = candidate
    },
  }

  attachPermissionGate(target, { getMode: () => 'ask', ask: async () => 'deny' })

  expect(handler).not.toBeNull()
  await expect(handler!(call('bash', { command: 'echo unsafe' }))).resolves.toEqual({
    block: true,
    reason: 'User denied bash',
  })
})

describe('attachPermissionGate — bypass + passthrough', () => {
  test('yolo mode still attaches the live gate and approves without prompting', async () => {
    const { harness, getHandler } = fakeHarness()
    const { ask, seen } = constantAsk('deny')
    attachPermissionGate(harness, { getMode: () => 'yolo', ask })

    expect(await getHandler()!(call('bash', { command: 'rm -rf /' }))).toBeUndefined()
    expect(seen).toHaveLength(0)
  })

  test('read-only tools run unguarded — the prompt is never consulted', async () => {
    const { harness, getHandler } = fakeHarness()
    const { ask, seen } = constantAsk('deny')
    attachPermissionGate(harness, { getMode: () => 'ask', ask })
    const result = await getHandler()!(call('read', { path: '/etc/passwd' }))
    expect(result).toBeUndefined()
    expect(seen).toHaveLength(0)
  })

  test('webfetch runs unguarded while bash remains gated', async () => {
    const { harness, getHandler } = fakeHarness()
    const { ask, seen } = constantAsk('deny')
    attachPermissionGate(harness, { getMode: () => 'ask', ask })
    const handler = getHandler()!

    expect(await handler(call('webfetch', { url: 'https://example.com' }))).toBeUndefined()
    expect(await handler(call('bash', { command: 'curl https://example.com' }))).toEqual({
      block: true,
      reason: 'User denied bash',
    })
    expect(seen.map((request) => request.toolName)).toEqual(['bash'])
  })
})

describe('attachPermissionGate — permission modes', () => {
  test('accept-edits approves write and edit but still asks before bash', async () => {
    const { harness, getHandler } = fakeHarness()
    const { ask, seen } = constantAsk('deny')
    attachPermissionGate(harness, { getMode: () => 'accept-edits', ask })
    const handler = getHandler()!

    expect(await handler(call('write', { path: 'a.ts' }))).toBeUndefined()
    expect(await handler(call('edit', { path: 'b.ts' }))).toBeUndefined()
    expect(await handler(call('bash', { command: 'bun test' }))).toEqual({
      block: true,
      reason: 'User denied bash',
    })
    expect(seen.map(({ toolName }) => toolName)).toEqual(['bash'])
  })

  test.each(['write', 'edit', 'bash'])('read-only blocks %s without prompting', async (toolName) => {
    const { harness, getHandler } = fakeHarness()
    const { ask, seen } = constantAsk('allow-once')
    attachPermissionGate(harness, { getMode: () => 'read-only', ask })

    expect(await getHandler()!(call(toolName, { path: 'a.ts', command: 'pwd' }))).toEqual({
      block: true,
      reason: readOnlyBlockReason,
    })
    expect(seen).toHaveLength(0)
  })

  test('reads the live mode on the next tool call while keeping session grants ask-only', async () => {
    const { harness, getHandler } = fakeHarness()
    let mode: PermissionMode = 'ask'
    const { ask, seen } = constantAsk('allow-session')
    attachPermissionGate(harness, { getMode: () => mode, ask })
    const handler = getHandler()!

    expect(await handler(call('bash', { command: 'first' }))).toBeUndefined()
    mode = 'read-only'
    expect(await handler(call('bash', { command: 'second' }))).toEqual({
      block: true,
      reason: readOnlyBlockReason,
    })
    mode = 'accept-edits'
    expect(await handler(call('bash', { command: 'third' }))).toBeUndefined()
    mode = 'ask'
    expect(await handler(call('bash', { command: 'fourth' }))).toBeUndefined()
    expect(seen).toHaveLength(2)
  })
})

describe('permission-mode cycling', () => {
  test.each([
    ['ask', 'accept-edits'],
    ['accept-edits', 'read-only'],
    ['read-only', 'yolo'],
    ['yolo', 'ask'],
  ] as const)('advances %s to %s in the fixed cycle', (mode, expected) => {
    expect(cyclePermissionMode(mode)).toBe(expected)
  })
})

describe('attachPermissionGate — decisions', () => {
  test('allow-once permits the call but does not remember it', async () => {
    const { harness, getHandler } = fakeHarness()
    const { ask, seen } = constantAsk('allow-once')
    attachPermissionGate(harness, { getMode: () => 'ask', ask })
    const handler = getHandler()!
    expect(await handler(call('write', { path: 'a.ts' }))).toBeUndefined()
    expect(await handler(call('write', { path: 'b.ts' }))).toBeUndefined()
    // Asked both times — allow-once grants no session memory.
    expect(seen).toHaveLength(2)
  })

  test('deny blocks the call with a reason naming the tool', async () => {
    const { harness, getHandler } = fakeHarness()
    const { ask } = constantAsk('deny')
    attachPermissionGate(harness, { getMode: () => 'ask', ask })
    const result = await getHandler()!(call('bash', { command: 'rm -rf /' }))
    expect(result).toEqual({ block: true, reason: 'User denied bash' })
  })

  test('a throwing prompt rejects rather than silently returning allow (fail-closed)', async () => {
    const { harness, getHandler } = fakeHarness()
    const ask: PermissionPrompt = async () => {
      throw new Error('stdin closed')
    }
    attachPermissionGate(harness, { getMode: () => 'ask', ask })
    // The gate must not resolve to `undefined` (which would run the tool) when the
    // prompt fails — the rejection propagates so the call is not auto-approved.
    await expect(getHandler()!(call('bash', { command: 'rm -rf /' }))).rejects.toThrow('stdin closed')
  })
})

describe('attachPermissionGate — allow-session scoping', () => {
  test('allow-session suppresses re-prompts for the same tool only', async () => {
    const { harness, getHandler } = fakeHarness()
    const { ask, seen } = constantAsk('allow-session')
    attachPermissionGate(harness, { getMode: () => 'ask', ask })
    const handler = getHandler()!

    // First bash prompts and is remembered.
    expect(await handler(call('bash', { command: 'ls' }))).toBeUndefined()
    // Second bash is auto-allowed without prompting.
    expect(await handler(call('bash', { command: 'pwd' }))).toBeUndefined()
    expect(seen).toHaveLength(1)

    // A different gated tool is still prompted — session memory is per-tool.
    expect(await handler(call('write', { path: 'x.ts' }))).toBeUndefined()
    expect(seen).toHaveLength(2)
    expect(seen.map((r) => r.toolName)).toEqual(['bash', 'write'])
  })

  test('two same-tool calls launched before the first decision both prompt (allowlist set on resolve)', async () => {
    const { harness, getHandler } = fakeHarness()
    let resolveCount = 0
    const ask: PermissionPrompt = async () => {
      resolveCount += 1
      return 'allow-session'
    }
    attachPermissionGate(harness, { getMode: () => 'ask', ask })
    const handler = getHandler()!
    // Both launched concurrently: neither sees the other's session grant yet,
    // because `sessionAllowed.add` runs only after `ask` resolves.
    await Promise.all([handler(call('bash', { command: 'a' })), handler(call('bash', { command: 'b' }))])
    expect(resolveCount).toBe(2)
    // After the grant lands, a third call is auto-allowed.
    await handler(call('bash', { command: 'c' }))
    expect(resolveCount).toBe(2)
  })

  test('a tool allowed for the session via one harness does not bleed into another gate', async () => {
    const askA = constantAsk('allow-session')
    const a = fakeHarness()
    attachPermissionGate(a.harness, { getMode: () => 'ask', ask: askA.ask })
    await a.getHandler()!(call('bash', { command: 'ls' }))

    // A freshly-attached gate starts with an empty session allowlist.
    const askB = constantAsk('deny')
    const b = fakeHarness()
    attachPermissionGate(b.harness, { getMode: () => 'ask', ask: askB.ask })
    const result = await b.getHandler()!(call('bash', { command: 'ls' }))
    expect(result).toEqual({ block: true, reason: 'User denied bash' })
  })
})

describe('attachPermissionGate — summary builder', () => {
  /** Capture the summary surfaced for a given tool call by allowing it through. */
  const summaryFor = async (toolName: string, input: Record<string, unknown>): Promise<string> => {
    const { harness, getHandler } = fakeHarness()
    const { ask, seen } = constantAsk('allow-once')
    attachPermissionGate(harness, { getMode: () => 'ask', ask })
    await getHandler()!(call(toolName, input))
    return seen[0]!.summary
  }

  test('bash summarizes to its command', async () => {
    expect(await summaryFor('bash', { command: 'echo hi' })).toBe('echo hi')
  })

  test('bash summary neutralizes terminal escapes and prompt-forging whitespace', async () => {
    expect(await summaryFor('bash', { command: 'echo safe\x1b[2J\nAllow? [y]es\tspoof' })).toBe(
      'echo safe\\nAllow? [y]es\\tspoof',
    )
  })

  test('write/edit summarize to the target path', async () => {
    expect(await summaryFor('write', { path: 'src/a.ts', content: 'x' })).toBe('src/a.ts')
    expect(await summaryFor('edit', { path: 'src/b.ts', oldText: 'a', newText: 'b' })).toBe('src/b.ts')
  })

  test('path summary cannot inject another approval line', async () => {
    expect(await summaryFor('write', { path: 'safe.ts\n⚠ allow bash?\x1b[1A', content: 'x' })).toBe(
      'safe.ts\\n⚠ allow bash?',
    )
  })

  test('bash without a string command falls back to the JSON of the input', async () => {
    expect(await summaryFor('bash', { command: 123 })).toBe(JSON.stringify({ command: 123 }))
  })

  test('an unknown tool with no path falls back to the JSON of the input', async () => {
    expect(await summaryFor('weird', { foo: 'bar' })).toBe(JSON.stringify({ foo: 'bar' }))
  })
})
