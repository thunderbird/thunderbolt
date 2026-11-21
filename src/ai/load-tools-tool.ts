/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * On-demand loading of MCP connection tools.
 *
 * Connection tools stay registered but out of the active set, so their
 * definitions don't ride every request. The system prompt lists their names and
 * the model calls `load_tools` to activate the ones it needs. A tool loaded
 * earlier in a chat stays active for the rest of it: the state is derived from
 * the chat's own `load_tools` calls rather than stored.
 */

import type { ThunderboltUIMessage } from '@/types'
import { getToolName, isToolUIPart, tool, type Tool } from 'ai'
import { z } from 'zod'

export const loadToolsToolName = 'load_tools'

export type LoadToolsResult = {
  readonly loaded: string[]
  readonly notFound: string[]
}

/**
 * Split requested names into known connection tools and unknown names, without duplicates.
 *
 * @param requested - names the model asked for; non-string entries are ignored
 * @param connectionToolNames - every registered connection tool name
 */
export const resolveToolNames = (
  requested: readonly unknown[],
  connectionToolNames: ReadonlySet<string>,
): LoadToolsResult => {
  const names = [...new Set(requested.filter((name): name is string => typeof name === 'string'))]
  return {
    loaded: names.filter((name) => connectionToolNames.has(name)),
    notFound: names.filter((name) => !connectionToolNames.has(name)),
  }
}

/** Read `names` from a `load_tools` call's input, which may come from history or a weak model. */
const namesFromLoadToolsInput = (input: unknown): unknown[] => {
  const names = (input as { names?: unknown } | null | undefined)?.names
  return Array.isArray(names) ? names : []
}

/**
 * Create the `load_tools` tool, which activates connection tools by name.
 *
 * Execution only validates and echoes the names; each engine activates them
 * for the following steps. Throws when no name matches so the model sees an
 * error and can retry with names from the system prompt.
 *
 * @param connectionToolNames - every registered connection tool name
 */
export const createLoadToolsTool = (
  connectionToolNames: ReadonlySet<string>,
): Tool<{ names: string[] }, LoadToolsResult> =>
  tool({
    description:
      'Load connection tools by exact name so you can call them. Names are listed under Connected MCP Servers in the system prompt. Loaded tools stay available for the rest of the chat.',
    inputSchema: z.object({
      names: z.array(z.string()).min(1).describe('Exact tool names to load'),
    }),
    execute: async ({ names }) => {
      const result = resolveToolNames(names, connectionToolNames)
      if (result.loaded.length === 0) {
        throw new Error(`No connection tools match: ${result.notFound.join(', ')}`)
      }
      return result
    },
  })

/**
 * Connection tools loaded by the given successful `load_tools` calls.
 *
 * @param calls - finished tool calls, from history or either engine
 * @param connectionToolNames - every registered connection tool name
 */
export const loadedToolNamesFromCalls = (
  calls: readonly { readonly toolName: string; readonly input: unknown }[],
  connectionToolNames: ReadonlySet<string>,
): string[] =>
  resolveToolNames(
    calls.filter((call) => call.toolName === loadToolsToolName).flatMap((call) => namesFromLoadToolsInput(call.input)),
    connectionToolNames,
  ).loaded

/**
 * Connection tools loaded by finished `load_tools` calls in the chat history.
 *
 * Names are re-resolved against the current connections, so a tool from a
 * connection removed since then drops out.
 *
 * @param messages - the chat's UI messages
 * @param connectionToolNames - every registered connection tool name
 */
export const loadedToolNamesFromHistory = (
  messages: readonly ThunderboltUIMessage[],
  connectionToolNames: ReadonlySet<string>,
): string[] =>
  loadedToolNamesFromCalls(
    messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        isToolUIPart(part) && part.state === 'output-available'
          ? [{ toolName: getToolName(part), input: part.input }]
          : [],
      ),
    ),
    connectionToolNames,
  )

/**
 * Active tool names: every non-connection tool plus the loaded connection tools.
 *
 * @param allToolNames - every registered tool name
 * @param connectionToolNames - every registered connection tool name
 * @param loaded - connection tools loaded so far in the chat
 */
export const selectActiveToolNames = (
  allToolNames: readonly string[],
  connectionToolNames: ReadonlySet<string>,
  loaded: readonly string[],
): string[] => {
  const loadedSet = new Set(loaded)
  return allToolNames.filter((name) => !connectionToolNames.has(name) || loadedSet.has(name))
}
