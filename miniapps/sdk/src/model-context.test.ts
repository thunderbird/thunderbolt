/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `document.modelContext` — the shim, and the native-delegation path.
 *
 * Native WebMCP is stubbed rather than driven for real, and that is the only
 * option available: it lands in Chromium behind an origin trial from 149, and
 * the Playwright build this repo pins is 148. Bumping it to reach one browser
 * revision would retarget every e2e test in the repo at a browser nobody asked
 * for, to test a code path whose entire content is "call the object that is
 * already there".
 *
 * Which is also why a stub is enough here. The three things that can go wrong
 * with native detection are all shape, not behaviour: we mistake something else
 * for it, we destroy it, or we fail to notice it. A fake object with the right
 * methods exercises all three, and the real browser adds nothing a fake cannot
 * say. What a stub genuinely cannot cover is whether Chrome's implementation
 * honours the spec — and that is not ours to assert.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import {
  createModelContextShim,
  descriptorSignature,
  flattenToolResult,
  installModelContext,
  maxToolSchemaChars,
  nativeModelContext,
  resetModelContextForTests,
  textResult,
  toDescriptor,
  type ModelContext,
  type ModelContextTool,
  type ModelContextToolResult,
} from './model-context'

type DocumentWithModelContext = Document & { modelContext?: unknown }

const echo = (name: string, text = 'ok'): ModelContextTool => ({
  name,
  description: `Echoes ${text}.`,
  execute: () => textResult(text),
})

/** A fake native implementation: right shape, recognisably not ours. */
const fakeNative = (): ModelContext & { registered: ModelContextTool[] } => {
  const registered: ModelContextTool[] = []
  return {
    registered,
    registerTool: async (tool) => {
      registered.push(tool)
    },
    getTools: async () => registered,
    executeTool: async (tool) => textResult(`native ran ${typeof tool === 'string' ? tool : tool.name}`),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

/*
 * Both hooks, not just teardown: this module installs its shim at import, so
 * the very first test would otherwise run against an already-populated
 * `document`.
 */
beforeEach(() => {
  resetModelContextForTests()
})

afterEach(() => {
  resetModelContextForTests()
})

describe('installModelContext', () => {
  it('installs a shim on a document that has none', () => {
    const { modelContext, native } = installModelContext()

    expect(native).toBe(false)
    expect((document as DocumentWithModelContext).modelContext).toBe(modelContext)
  })

  /*
   * Two copies of the SDK on one page is the normal case, not an edge one: a
   * Mini App that vendored the SDK sits inside a host that also ships it. Each
   * copy has its own module state, so the second one's `installed` memo is
   * empty and only the document can tell it that a registry already exists.
   */
  it('adopts a shim another copy of this module already installed', async () => {
    const first = installModelContext()
    await first.modelContext.registerTool(echo('from_the_first_copy'))
    // What a second copy sees: its own memo empty, the document already set.
    resetModelContextForTests({ keepDocument: true })

    const second = installModelContext()

    expect(second.native).toBe(false)
    expect(second.modelContext).toBe(first.modelContext)
    expect((await second.modelContext.getTools()).map((tool) => tool.name)).toEqual(['from_the_first_copy'])
  })

  it('is idempotent, so two callers share one registry', async () => {
    const first = installModelContext()
    await first.modelContext.registerTool(echo('alpha'))

    const second = installModelContext()

    expect(second.modelContext).toBe(first.modelContext)
    expect((await second.modelContext.getTools()).map((tool) => tool.name)).toEqual(['alpha'])
  })

  /**
   * The acceptance criterion, and the one that matters: tools registered by
   * code that has never heard of Thunderbolt survive us loading.
   */
  it('uses native WebMCP as-is and never reassigns it', async () => {
    const native = fakeNative()
    await native.registerTool(echo('registered_before_us'))
    ;(document as DocumentWithModelContext).modelContext = native

    const installation = installModelContext()

    expect(installation.native).toBe(true)
    expect(installation.modelContext).toBe(native)
    expect((document as DocumentWithModelContext).modelContext).toBe(native)
    expect((await installation.modelContext.getTools()).map((tool) => tool.name)).toEqual(['registered_before_us'])
  })

  it('routes registration and execution to native rather than shadowing it', async () => {
    const native = fakeNative()
    ;(document as DocumentWithModelContext).modelContext = native

    const { modelContext } = installModelContext()
    await modelContext.registerTool(echo('beta'))

    expect(native.registered.map((tool) => tool.name)).toEqual(['beta'])
    expect(flattenToolResult(await modelContext.executeTool(echo('beta')))).toEqual({ content: 'native ran beta' })
  })

  /**
   * Half a `modelContext` is worse than none — tools would register into
   * something the bridge cannot read back — but destroying a stranger's object
   * is not the fix. Degrade, and say so.
   */
  it('leaves a foreign modelContext alone, warns, and falls back to a detached registry', async () => {
    const foreign = { registerTool: () => {} }
    ;(document as DocumentWithModelContext).modelContext = foreign
    const warn = mock(() => {})
    const realWarn = console.warn
    console.warn = warn

    try {
      const { modelContext, native } = installModelContext()

      expect(native).toBe(false)
      expect((document as DocumentWithModelContext).modelContext).toBe(foreign)
      expect(modelContext).not.toBe(foreign)
      expect(warn).toHaveBeenCalledTimes(1)
      // Still a working registry, so the `tools` option keeps reaching the host.
      await modelContext.registerTool(echo('gamma'))
      expect((await modelContext.getTools()).map((tool) => tool.name)).toEqual(['gamma'])
    } finally {
      console.warn = realWarn
    }
  })
})

describe('nativeModelContext', () => {
  it('is null when nothing is there', () => {
    expect(nativeModelContext()).toBeNull()
  })

  /**
   * The shim answers every check native would — it implements the same
   * interface — so duck-typing alone would report our own installation as the
   * browser's and hand a second SDK copy someone else's registry as though it
   * were native.
   */
  it('does not mistake our own shim for the browser', () => {
    installModelContext()

    expect(nativeModelContext()).toBeNull()
  })

  it.each(['registerTool', 'getTools', 'executeTool'])('rejects an implementation missing %s', (missing) => {
    const partial: Record<string, unknown> = fakeNative() as unknown as Record<string, unknown>
    delete partial[missing]
    ;(document as DocumentWithModelContext).modelContext = partial

    expect(nativeModelContext()).toBeNull()
  })

  it('accepts one with all three', () => {
    const native = fakeNative()
    ;(document as DocumentWithModelContext).modelContext = native

    expect(nativeModelContext()).toBe(native)
  })
})

describe('the shim registry', () => {
  it('lists tools in the order they were registered', async () => {
    const shim = createModelContextShim()
    await shim.registerTool(echo('first'))
    await shim.registerTool(echo('second'))

    expect((await shim.getTools()).map((tool) => tool.name)).toEqual(['first', 'second'])
  })

  it('runs a tool and returns its content', async () => {
    const shim = createModelContextShim()
    await shim.registerTool(echo('greet', 'hello'))

    expect(flattenToolResult(await shim.executeTool('greet'))).toEqual({ content: 'hello' })
  })

  it('passes arguments through', async () => {
    const shim = createModelContextShim()
    await shim.registerTool({
      name: 'add',
      description: 'Adds two numbers.',
      execute: ({ a, b }: { a: number; b: number }) => textResult(String(a + b)),
    } as unknown as ModelContextTool)

    expect(flattenToolResult(await shim.executeTool('add', { a: 2, b: 3 }))).toEqual({ content: '5' })
  })

  /** The model gets something it can act on, not a broken-tool rejection. */
  it('reports a throwing tool as an error result rather than rejecting', async () => {
    const shim = createModelContextShim()
    await shim.registerTool({
      name: 'explode',
      description: 'Always throws.',
      execute: () => {
        throw new Error('nope')
      },
    })

    expect(flattenToolResult(await shim.executeTool('explode'))).toEqual({ content: 'nope', isError: true })
  })

  it('reports an unknown name instead of rejecting', async () => {
    const shim = createModelContextShim()

    const result = flattenToolResult(await shim.executeTool('ghost'))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('No tool named "ghost"')
  })

  it('replaces a duplicate name rather than listing it twice', async () => {
    const shim = createModelContextShim()
    await shim.registerTool(echo('dup', 'old'))
    await shim.registerTool(echo('dup', 'new'))

    expect(await shim.getTools()).toHaveLength(1)
    expect(flattenToolResult(await shim.executeTool('dup'))).toEqual({ content: 'new' })
  })

  describe('unregistration', () => {
    it('removes a tool when its signal aborts', async () => {
      const shim = createModelContextShim()
      const controller = new AbortController()
      await shim.registerTool(echo('temporary'), { signal: controller.signal })

      controller.abort()

      expect(await shim.getTools()).toEqual([])
    })

    it('registers nothing for a signal that has already aborted', async () => {
      const shim = createModelContextShim()
      const changes = mock(() => {})
      shim.addEventListener('toolchange', changes)
      const controller = new AbortController()
      controller.abort()

      await shim.registerTool(echo('stillborn'), { signal: controller.signal })

      expect(await shim.getTools()).toEqual([])
      expect(changes).not.toHaveBeenCalled()
    })

    /**
     * A re-register under the same name is a *different* tool, and the first
     * registration's signal does not own it. Without the guard, a React effect
     * cleaning up after a re-render would delete the tool the re-render just
     * installed — the tool vanishes on the second render and never comes back.
     */
    it('does not let a stale signal remove the tool that replaced it', async () => {
      const shim = createModelContextShim()
      const first = new AbortController()
      const second = new AbortController()
      await shim.registerTool(echo('shared', 'old'), { signal: first.signal })
      await shim.registerTool(echo('shared', 'new'), { signal: second.signal })

      first.abort()

      expect((await shim.getTools()).map((tool) => tool.name)).toEqual(['shared'])
      expect(flattenToolResult(await shim.executeTool('shared'))).toEqual({ content: 'new' })
    })
  })

  describe('toolchange', () => {
    it('fires on register and on unregister', async () => {
      const shim = createModelContextShim()
      const changes = mock(() => {})
      shim.addEventListener('toolchange', changes)
      const controller = new AbortController()

      await shim.registerTool(echo('watched'), { signal: controller.signal })
      expect(changes).toHaveBeenCalledTimes(1)

      controller.abort()
      expect(changes).toHaveBeenCalledTimes(2)
    })

    it('stops firing once removed', async () => {
      const shim = createModelContextShim()
      const changes = mock(() => {})
      shim.addEventListener('toolchange', changes)
      shim.removeEventListener('toolchange', changes)

      await shim.registerTool(echo('unwatched'))

      expect(changes).not.toHaveBeenCalled()
    })
  })

  /**
   * On the app author's own stack, where the code is. The host validates too,
   * but it warns in Thunderbolt's console about a frame someone else wrote.
   */
  describe('descriptor validation', () => {
    it('rejects a name with a dot, which would fail the whole model request', async () => {
      const shim = createModelContextShim()

      await expect(shim.registerTool(echo('finance.total'))).rejects.toThrow('[a-zA-Z0-9_-]')
    })

    it('rejects a name over the host budget', async () => {
      const shim = createModelContextShim()

      await expect(shim.registerTool(echo('n'.repeat(61)))).rejects.toThrow('1-60 characters')
    })

    it('rejects a missing description', async () => {
      const shim = createModelContextShim()

      await expect(shim.registerTool({ ...echo('nameless'), description: '' })).rejects.toThrow('needs a description')
    })

    it('rejects a descriptor with no execute', async () => {
      const shim = createModelContextShim()

      await expect(
        shim.registerTool({ name: 'inert', description: 'Does nothing.' } as unknown as ModelContextTool),
      ).rejects.toThrow('no execute function')
    })

    /*
     * The host drops a descriptor it cannot serialise (`parseToolsList`), so a
     * tool like this would never reach the model. Rejecting here puts the
     * failure on the author's own stack instead of in Thunderbolt's console.
     */
    it('rejects a schema holding a circular reference', async () => {
      const shim = createModelContextShim()
      const cyclic: Record<string, unknown> = { type: 'object' }
      cyclic.self = cyclic

      await expect(shim.registerTool({ ...echo('cyclic'), inputSchema: cyclic })).rejects.toThrow(
        'not JSON-serialisable',
      )
    })

    it('rejects a schema holding a BigInt', async () => {
      const shim = createModelContextShim()

      await expect(shim.registerTool({ ...echo('big'), inputSchema: { maximum: 10n } })).rejects.toThrow(
        'not JSON-serialisable',
      )
    })

    it('rejects a schema over the budget it would spend on every request', async () => {
      const shim = createModelContextShim()
      const huge = { type: 'object', description: 'x'.repeat(maxToolSchemaChars) }

      await expect(shim.registerTool({ ...echo('huge'), inputSchema: huge })).rejects.toThrow(
        `${maxToolSchemaChars}-character limit`,
      )
    })

    it('accepts a schema just inside the budget', async () => {
      const shim = createModelContextShim()
      const snug = { type: 'object', description: 'x'.repeat(maxToolSchemaChars - 100) }

      await shim.registerTool({ ...echo('snug'), inputSchema: snug })

      expect(await shim.getTools()).toHaveLength(1)
    })

    it('accepts the full legal name alphabet at the length limit', async () => {
      const shim = createModelContextShim()

      await shim.registerTool(echo(`${'a-Z_9'.repeat(11)}abcde`))

      expect(await shim.getTools()).toHaveLength(1)
    })
  })
})

describe('toDescriptor', () => {
  it('drops execute and omits the optional keys the app left out', () => {
    expect(toDescriptor(echo('plain'))).toEqual({ name: 'plain', description: 'Echoes ok.' })
  })

  it('keeps inputSchema and annotations when present', () => {
    const descriptor = toDescriptor({
      ...echo('full'),
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, title: 'Full' },
    })

    expect(descriptor).toEqual({
      name: 'full',
      description: 'Echoes ok.',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, title: 'Full' },
    })
  })
})

describe('descriptorSignature', () => {
  it('is stable for an unchanged descriptor and moves when one does', () => {
    const before = descriptorSignature({ ...echo('a'), inputSchema: { type: 'object' } })

    expect(descriptorSignature({ ...echo('a'), inputSchema: { type: 'object' } })).toBe(before)
    expect(descriptorSignature({ ...echo('a'), inputSchema: { type: 'string' } })).not.toBe(before)
  })

  /*
   * `inputSchema` is arbitrary app-supplied JSON Schema, and `postMessage` is
   * happy with both of these — structured clone carries cycles and BigInt — so
   * such a tool genuinely exists and works. A throw here took down a React
   * render in one caller and cost the app every *other* tool in the other.
   */
  it('returns null for a schema holding a cycle rather than throwing', () => {
    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic.self = cyclic

    expect(descriptorSignature({ ...echo('a'), inputSchema: cyclic })).toBeNull()
  })

  it('returns null for a schema holding a BigInt rather than throwing', () => {
    expect(descriptorSignature({ ...echo('a'), inputSchema: { maximum: 10n } })).toBeNull()
  })
})

describe('flattenToolResult', () => {
  it('joins multiple text parts, which the one-string wire cannot carry separately', () => {
    expect(
      flattenToolResult({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toEqual({
      content: 'a\nb',
    })
  })

  it('omits isError rather than sending false, which the host reads as a failure flag', () => {
    expect(flattenToolResult({ content: [{ type: 'text', text: 'fine' }], isError: false })).toEqual({
      content: 'fine',
    })
  })

  it('drops parts that are not text, since the wire has nowhere to put them', () => {
    const mixed = {
      content: [{ type: 'image' }, { type: 'text', text: 'kept' }],
    } as unknown as ModelContextToolResult

    expect(flattenToolResult(mixed)).toEqual({ content: 'kept' })
  })
})
