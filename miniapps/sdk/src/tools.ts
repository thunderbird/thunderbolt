/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The `tools` option — a thin convenience over `document.modelContext`.
 *
 * The canonical way to expose a tool is WebMCP's own call, which this SDK makes
 * available in every browser (see `model-context.ts`):
 *
 * ```ts
 * document.modelContext.registerTool({
 *   name: 'highlight_row',
 *   description: 'Highlight one row of the model.',
 *   inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
 *   execute: ({ id }) => {
 *     select(id)
 *     return { content: [{ type: 'text', text: `Highlighted ${id}.` }] }
 *   },
 * })
 * ```
 *
 * `useThunderbolt(name, tools)` exists beside it because React apps almost
 * always *have* their tool list already — as an array rebuilt each render, whose
 * `execute` closures need current state — and turning that into imperative
 * register/abort calls in an effect is boilerplate with a stale-closure bug
 * waiting in it. The bridge mirrors the array into the registry instead, so both
 * spellings end up in the same place and the host reads one list.
 *
 * The only difference between the two shapes is the return type: `execute` here
 * returns a plain string, because that is what a one-line tool wants to write
 * and the wire carries one string anyway. Hand the same object to native
 * WebMCP and it would need `{ content: [{ type: 'text', text }] }`, so a tool
 * meant to be portable should be written the canonical way above.
 */

import { textResult, type ModelContextTool } from './model-context'

/**
 * A tool your app exposes, in the shape the `tools` option takes.
 *
 * Field-for-field WebMCP's descriptor apart from `execute`'s return type — see
 * {@link ModelContextTool}, which documents the name and annotation rules that
 * apply to both.
 */
export type ThunderboltTool = Omit<ModelContextTool, 'execute'> & {
  /** Runs the tool. Return a string the model will read. */
  execute: (args: never) => Promise<string> | string
}

/** Adapt one to the registry's shape, widening `execute`'s string to a result. */
export const toModelContextTool = ({ execute, ...descriptor }: ThunderboltTool): ModelContextTool => ({
  ...descriptor,
  execute: async (args) => textResult(String(await execute(args))),
})
