/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Declaring tools your app exposes to the Thunderbolt assistant.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS ISN'T JUST WebMCP
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WebMCP (`document.modelContext.registerTool`) is the browser-native answer to
 * exactly this problem, and it explicitly supports our topology — a parent page
 * discovering tools inside a cross-origin iframe via `allow="tools"` on the frame
 * plus `exposedTo` on registration. If it were available everywhere Thunderbolt
 * runs, this file would not exist.
 *
 * It isn't, for three reasons that are about deployment rather than design:
 *
 *   1. **Thunderbolt's desktop app can't run it.** Tauri embeds WKWebView on
 *      macOS and WebKitGTK on Linux — both WebKit, neither implements WebMCP, and
 *      no flag or config changes that. Only Windows (WebView2, Chromium) could.
 *      Desktop is a first-class Thunderbolt surface, so a WebMCP-only tool layer
 *      would quietly be a web-only feature.
 *
 *   2. **It's an origin trial, not a shipped API.** Chrome 146 has an
 *      implementation; the public origin trial runs Chrome 149→156. Origin trials
 *      expire, and this one is a W3C *Community Group* draft — not standards
 *      track. The surface has already moved once (`navigator.modelContext` →
 *      `document.modelContext`).
 *
 *   3. **Mozilla is neutral; Safari uncommitted.** Both participate in the spec
 *      discussion, neither has committed to shipping.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SO: SAME SHAPE, DIFFERENT TRANSPORT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `ThunderboltTool` below is deliberately WebMCP's tool descriptor. Same fields,
 * same meanings, same `annotations.readOnlyHint` semantics. Which means:
 *
 *   - If you already register tools with WebMCP, hand us the same objects.
 *     `toWebMcpTools()` at the bottom of this file goes the other way, and is
 *     about ten lines.
 *   - If WebMCP ships broadly, Thunderbolt feature-detects `document.modelContext`
 *     and prefers it. Your tool definitions don't change.
 *
 * The transport underneath is JSON-RPC 2.0 over `postMessage`, using MCP's own
 * method names (`tools/list`, `tools/call`).
 */

/** A tool your app exposes. Mirrors WebMCP's descriptor. */
export type ThunderboltTool = {
  /** Unique, `[a-zA-Z0-9_.-]`, 1–128 chars. WebMCP's constraint, kept verbatim. */
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
  /** Runs the tool. Return a string the model will read. */
  execute: (args: never) => Promise<string> | string
}

/** What `execute` returns to the host, matching the wire's `tools/call` result. */
export type ToolCallResult = { content: string; isError?: boolean }

/** Strip `execute` — the host only ever learns a tool's *name*, never its body. */
export const toDescriptors = (tools: ThunderboltTool[]) =>
  tools.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    ...(inputSchema ? { inputSchema } : {}),
    ...(annotations ? { annotations } : {}),
  }))

/**
 * Invoke a declared tool by name.
 *
 * Errors are returned rather than thrown so the model gets something it can act
 * on. A thrown error would surface as "the tool is broken"; a message saying what
 * went wrong lets it retry with different arguments or explain the problem.
 */
export const callTool = async (tools: ThunderboltTool[], name: string, args: unknown): Promise<ToolCallResult> => {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) {
    return { content: `No tool named "${name}" is registered.`, isError: true }
  }
  try {
    return { content: String(await tool.execute(args as never)) }
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true }
  }
}

/**
 * Register the same tools with WebMCP, where it exists.
 *
 * Not used by this sample — Thunderbolt reaches tools over the bridge, and the
 * desktop app has no `document.modelContext` at all. It's here to make the point
 * concrete: because the descriptor is WebMCP-shaped, supporting *other* browser
 * agents alongside Thunderbolt costs about ten lines and no change to how you
 * define a tool.
 */
export const toWebMcpTools = async (tools: ThunderboltTool[], exposedTo?: string[]): Promise<boolean> => {
  const modelContext = (
    document as Document & { modelContext?: { registerTool: (t: unknown, o?: unknown) => Promise<void> } }
  ).modelContext
  if (!modelContext) {
    return false
  }
  await Promise.all(tools.map((tool) => modelContext.registerTool(tool, exposedTo ? { exposedTo } : undefined)))
  return true
}
