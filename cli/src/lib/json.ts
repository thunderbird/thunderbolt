/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Shared narrowing helpers for parsed JSON values. */

export { isRecord } from '../../../shared/lib/is-record.ts'

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Parses JSON while replacing syntax failures with the caller's domain error. */
export const parseJson = (contents: string, invalid: Error): unknown => {
  try {
    return JSON.parse(contents) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) throw invalid
    throw error
  }
}

/** Narrows a JSON object only when its own enumerable keys exactly match the schema. */
export const hasExactKeys = <Key extends string>(
  value: Readonly<Record<string, unknown>>,
  keys: readonly Key[],
): value is Record<Key, unknown> => {
  const actualKeys = Object.keys(value)
  const expectedKeys = new Set<string>(keys)
  return actualKeys.length === expectedKeys.size && actualKeys.every((key) => expectedKeys.has(key))
}

/** Narrows strings that contain at least one non-whitespace character without changing their value. */
export const isNonblankString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
