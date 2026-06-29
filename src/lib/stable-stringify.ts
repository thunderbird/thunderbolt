/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Deterministic JSON stringify with every object's keys sorted, so two
 * structurally-equal inputs that differ only in key order produce the same
 * string. Arrays keep their order (it is semantically meaningful). Used to key
 * the per-request tool-call dedupe cache and to detect duplicate tool calls.
 */
export const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.keys(val as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((sorted, key) => {
            sorted[key] = (val as Record<string, unknown>)[key]
            return sorted
          }, {})
      : val,
  )

/**
 * Identity key for a tool call, from its name and finalized input. Shared by
 * the runtime per-request dedupe cache and the eval duplicate-call metric so
 * the two key formats can never drift apart.
 */
export const toolCallKey = (name: string, input: unknown): string => `${name}:${stableStringify(input)}`
