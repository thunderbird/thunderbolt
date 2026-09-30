/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `document.modelContext` — WebMCP where the browser has it, a shim where it
 * doesn't.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SHIM AND NOT A CHOICE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WebMCP is the browser-native answer to "let the page tell an agent what it can
 * do", and it explicitly supports our topology: a parent discovers tools inside a
 * cross-origin iframe via `allow="tools"` on the frame plus `exposedTo` on
 * registration. It is also not available in most places Thunderbolt runs —
 * Tauri's WKWebView and WebKitGTK have no implementation and no flag for one, and
 * on Chromium it is an origin trial (149→156) over a W3C *Community Group* draft
 * whose surface has already moved once (`navigator.modelContext` →
 * `document.modelContext`).
 *
 * Asking app authors to pick is the one option that is wrong in every
 * environment: pick WebMCP and desktop silently has no tools, pick our bridge
 * and the app is invisible to every other browser agent. So neither — apps write
 * WebMCP, and this file makes that true everywhere:
 *
 *   - **Native present** → we use it, unmodified. `document.modelContext` is
 *     never reassigned, never wrapped, never patched. The host reads tools out of
 *     it through `getTools()`/`executeTool()`, which are the spec's own accessors,
 *     so a tool registered by code that has never heard of Thunderbolt still
 *     works.
 *   - **Native absent** → we install a registry with the same shape, and the
 *     bridge serves `tools/list` / `tools/call` out of it over postMessage.
 *
 * Either way the app's tool definitions are identical, which is the whole point:
 * the day WebKit ships this, the shim stops installing and nothing else changes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS SPEC AND WHAT IS OURS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Spec, and relied on when native is present: `registerTool(descriptor, options)`
 * returning a promise, unregistration via `options.signal`, `getTools()`,
 * `executeTool(tool, args, options)`, a `{ content: [{ type, text }] }` result,
 * and the `toolchange` event.
 *
 * Ours, and true only of the shim: a duplicate `name` **replaces** the earlier
 * registration rather than throwing. A registry keyed by name has to answer this
 * somehow, and last-wins is the answer that survives a React re-render and a hot
 * reload. Don't write an app that depends on it either way.
 */

/** A tool result, in WebMCP's shape. */
export type ModelContextToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** A tool descriptor, in WebMCP's shape. */
export type ModelContextTool = {
  /**
   * Unique, `[a-zA-Z0-9_-]`, 1–60 characters.
   *
   * Tighter than WebMCP's own `[a-zA-Z0-9_.-]{1,128}`, and deliberately so: the
   * host prefixes the name with `app_` before handing it to a model provider,
   * and OpenAI allows no dots and caps the prefixed name at 64 — so a dot or a
   * long name does not cost you the tool, it gets the *whole request* rejected.
   * The shim throws on a name outside this range, because a name the host will
   * later drop is a bug in the app and it should fail where it was written.
   */
  name: string
  /** What it does, in natural language. The model reads this to decide. */
  description: string
  /** JSON Schema for the arguments. Omit for a tool that takes none. */
  inputSchema?: Record<string, unknown>
  annotations?: {
    /**
     * True for deterministic, side-effect-free tools. Read-only tools run
     * silently; **everything else prompts the user before it runs**, and an
     * omitted annotation means "prompt". Only your app knows whether a tool
     * mutates something, which is why this is your call and not the host's.
     */
    readOnlyHint?: boolean
    /** Friendly label shown in the approval prompt. Defaults to `name`. */
    title?: string
  }
  /** Runs the tool. */
  execute: (args: never) => ModelContextToolResult | Promise<ModelContextToolResult>
}

export type RegisterToolOptions = {
  /** Abort to unregister. WebMCP has no `unregisterTool`; this is the mechanism. */
  signal?: AbortSignal
  /**
   * Origins allowed to see this tool. Only meaningful to *native* WebMCP, which
   * uses it to gate cross-origin discovery through `allow="tools"`.
   *
   * The shim ignores it, and safely: its only consumer is the bridge, which is
   * already pinned to the single host origin `connect()` was given, so there is
   * no second origin for an allowlist to exclude.
   */
  exposedTo?: string[]
}

/** The subset of `document.modelContext` we use. Native satisfies it. */
export type ModelContext = {
  registerTool: (tool: ModelContextTool, options?: RegisterToolOptions) => Promise<void>
  getTools: () => Promise<ModelContextTool[]>
  executeTool: (
    tool: ModelContextTool | string,
    args?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<ModelContextToolResult>
  addEventListener: (type: 'toolchange', listener: () => void) => void
  removeEventListener: (type: 'toolchange', listener: () => void) => void
}

/** Longest tool name the host will accept. See {@link ModelContextTool.name}. */
export const maxToolNameLength = 60

const toolNamePattern = /^[a-zA-Z0-9_-]+$/

/** Text of a WebMCP result, joined. The wire carries one string, not parts. */
export const flattenToolResult = (result: ModelContextToolResult): { content: string; isError?: boolean } => ({
  content: result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n'),
  ...(result.isError ? { isError: true } : {}),
})

/** Wrap a plain string as a WebMCP result. */
export const textResult = (text: string, isError?: boolean): ModelContextToolResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
})

/**
 * Strip `execute` — the host only ever learns a tool's *name*, never its body.
 *
 * Takes the descriptor half rather than a whole tool so a {@link ThunderboltTool},
 * which differs only in what `execute` returns, needs no cast to pass through.
 */
export const toDescriptor = ({ name, description, inputSchema, annotations }: Omit<ModelContextTool, 'execute'>) => ({
  name,
  description,
  ...(inputSchema ? { inputSchema } : {}),
  ...(annotations ? { annotations } : {}),
})

/**
 * Reject a descriptor the host would later drop.
 *
 * Loud, and on the app's own stack. The host does validate — `parseToolsList`
 * drops a malformed descriptor and warns — but it warns in *Thunderbolt's*
 * console about code in someone else's frame, which is the worst place for an
 * app author to find out their tool never existed.
 */
const assertValidTool = (tool: ModelContextTool): void => {
  if (typeof tool.execute !== 'function') {
    throw new TypeError(`Tool "${tool.name}" has no execute function.`)
  }
  if (!tool.name || !toolNamePattern.test(tool.name) || tool.name.length > maxToolNameLength) {
    throw new TypeError(
      `Tool name "${tool.name}" must be 1-${maxToolNameLength} characters of [a-zA-Z0-9_-]. ` +
        'Thunderbolt prefixes it with `app_` for the model provider, which allows no dots and caps the result at 64.',
    )
  }
  if (!tool.description) {
    throw new TypeError(`Tool "${tool.name}" needs a description — it is what the model reads to decide.`)
  }
}

/**
 * Marks a `modelContext` as ours.
 *
 * Needed because a shim that satisfies the interface is, by construction,
 * indistinguishable from native by duck-typing — so without a brand we would
 * report our own installation as native, and a second copy of this SDK on the
 * page would adopt the first's registry believing it to be the browser's.
 *
 * `Symbol.for`, not `Symbol()`: two bundled copies of this module is the normal
 * case, not an edge one (a Mini App vendoring the SDK beside a host that also
 * ships it), and a module-local symbol would make each copy invisible to the
 * other. The global registry is what lets them agree.
 */
const shimBrand = Symbol.for('thunderbolt.miniapp.modelContextShim')

/** A shim, as distinct from whatever the browser may have put there. */
type ShimModelContext = ModelContext & { [shimBrand]: true }

/** Whether this `modelContext` is one of ours rather than the browser's. */
const isShim = (candidate: object): boolean => shimBrand in candidate

/**
 * A WebMCP-shaped registry with no browser behind it.
 *
 * Exported for the tests and for an app that wants a second, private registry;
 * ordinary use goes through {@link installModelContext}.
 */
export const createModelContextShim = (): ShimModelContext => {
  /* Insertion-ordered, name-keyed: the host sees tools in the order they were
   * registered, which is the order the author wrote them in. */
  const tools = new Map<string, ModelContextTool>()
  const listeners = new Set<() => void>()

  const emit = () => {
    for (const listener of [...listeners]) {
      listener()
    }
  }

  return {
    [shimBrand]: true,
    registerTool: async (tool, options) => {
      assertValidTool(tool)
      // An already-aborted signal means "register nothing", not "register then
      // immediately remove" — the difference is one spurious `toolchange`.
      if (options?.signal?.aborted) {
        return
      }
      tools.set(tool.name, tool)
      options?.signal?.addEventListener('abort', () => {
        // Guarded: a later registration under the same name is a *different*
        // tool, and this signal does not own it.
        if (tools.get(tool.name) === tool) {
          tools.delete(tool.name)
          emit()
        }
      })
      emit()
    },
    getTools: async () => [...tools.values()],
    executeTool: async (tool, args) => {
      const name = typeof tool === 'string' ? tool : tool.name
      const registered = tools.get(name)
      if (!registered) {
        return textResult(`No tool named "${name}" is registered.`, true)
      }
      /*
       * Errors come back as a result rather than a rejection, deliberately. A
       * rejection reads to the model as "the tool is broken"; a message saying
       * what went wrong lets it retry with different arguments or explain the
       * problem to the user.
       */
      try {
        return await registered.execute(args as never)
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true)
      }
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener)
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener)
    },
  }
}

type DocumentWithModelContext = Document & { modelContext?: ModelContext }

/**
 * Native WebMCP, if this browser has it.
 *
 * Duck-typed on the three methods we call rather than on the property existing.
 * The surface has already been renamed once, so a partial or older
 * implementation is a live possibility, and half a `modelContext` is worse than
 * none: the tools would register into something the bridge cannot read back.
 *
 * Our own shim is excluded by its brand, which duck-typing alone cannot do —
 * the shim implements this interface, so it answers every check native would.
 */
export const nativeModelContext = (): ModelContext | null => {
  if (typeof document === 'undefined') {
    return null
  }
  const candidate = (document as DocumentWithModelContext).modelContext
  if (
    !candidate ||
    isShim(candidate) ||
    typeof candidate.registerTool !== 'function' ||
    typeof candidate.getTools !== 'function' ||
    typeof candidate.executeTool !== 'function'
  ) {
    return null
  }
  return candidate
}

let installed: { modelContext: ModelContext; native: boolean } | null = null

/**
 * Get `document.modelContext`, installing the shim if the browser has none.
 *
 * Idempotent, and **non-destructive**: when native WebMCP is present this only
 * reads it. Overwriting it would take every tool registered by code that has
 * never heard of Thunderbolt — another SDK on the page, the app's own
 * pre-existing WebMCP support — and drop it on the floor.
 *
 * On the server, where a Next.js Mini App imports this module during SSR, it
 * hands back a detached registry and installs nothing: there is no `document`
 * to install onto and no agent to read it. Detached rather than memoized so one
 * request's registrations cannot be served to the next.
 */
export const installModelContext = (): { modelContext: ModelContext; native: boolean } => {
  if (typeof document === 'undefined') {
    return { modelContext: createModelContextShim(), native: false }
  }
  const native = nativeModelContext()
  if (native) {
    return { modelContext: native, native: true }
  }
  const existing = (document as DocumentWithModelContext).modelContext
  if (existing && isShim(existing)) {
    // Another copy of this module got here first. Adopt its registry rather
    // than installing a second one beside it, or the app's tools and the
    // bridge's reads would land in different maps.
    installed ??= { modelContext: existing, native: false }
    return installed
  }
  if (!installed) {
    const modelContext = createModelContextShim()
    /*
     * Something is already there and it is not a `modelContext` we can read
     * back — an implementation older than the rename, or another library's
     * polyfill. Left alone either way: "never overwritten" is not a rule about
     * complete implementations, it is a rule about not destroying registrations
     * we cannot see. The bridge gets a detached registry, so the `tools` option
     * still reaches the host, and the warning is the only way an author finds
     * out that their own `registerTool` calls are going somewhere we don't read.
     */
    if (existing) {
      console.warn(
        '[thunderbolt] document.modelContext is already set to something without ' +
          'registerTool/getTools/executeTool, so it has been left alone. Tools registered through it will not ' +
          'reach Thunderbolt — pass them to useThunderbolt/connect instead.',
      )
    } else {
      ;(document as DocumentWithModelContext).modelContext = modelContext
    }
    installed = { modelContext, native: false }
  }
  return installed
}

/**
 * Test seam. Drops our shim so the next install re-detects from scratch.
 *
 * `keepDocument` forgets only the module memo, which is what a *second copy* of
 * this module looks like: its own `installed` is empty while the document
 * already carries a shim. There is no other way to reach that state from one
 * import.
 */
export const resetModelContextForTests = (options?: { keepDocument?: boolean }): void => {
  installed = null
  if (!options?.keepDocument && typeof document !== 'undefined') {
    delete (document as DocumentWithModelContext).modelContext
  }
}

/*
 * Install on import, like any other polyfill.
 *
 * Not on `connect()`, which runs in an effect: an app that registers its tools
 * at module scope, or in a component that mounts before the bridge connects,
 * would find `document.modelContext` undefined and throw. A shim that only
 * exists after some other call is a shim with an ordering rule, and the native
 * API it stands in for has none.
 */
if (typeof document !== 'undefined') {
  installModelContext()
}
