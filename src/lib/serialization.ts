/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Utility functions for converting values between their typed representation
 * and their string storage format, with special handling for strings
 * to avoid extra quotes while maintaining round-trip safety.
 *
 * Supports: strings, numbers, booleans, null, objects, and arrays
 */

/**
 * Infer the type constructor from a schema value
 * Used to determine the type hint for deserialization
 *
 * @param schemaValue - The schema value (constructor or default value)
 * @returns The appropriate type constructor, or undefined for objects/arrays
 */
export const inferTypeFromSchema = (
  schemaValue: any,
): StringConstructor | BooleanConstructor | NumberConstructor | undefined => {
  // If it's already a constructor, return it
  if (typeof schemaValue === 'function') {
    return schemaValue as StringConstructor | BooleanConstructor | NumberConstructor
  }

  // Otherwise infer from the primitive default value's type
  if (typeof schemaValue === 'string') {
    return String
  }
  if (typeof schemaValue === 'boolean') {
    return Boolean
  }
  if (typeof schemaValue === 'number') {
    return Number
  }

  // Objects, arrays, null, etc. don't have type hints - use JSON fallback
  return undefined
}

/**
 * Serialize a typed value to a string for storage
 * Strings are stored unquoted for cleaner database storage
 * Other types use JSON.stringify
 *
 * @example
 * serializeValue('hello') → 'hello'
 * serializeValue('hello"world') → 'hello"world' (stored as-is)
 * serializeValue(42) → '42'
 * serializeValue(true) → 'true'
 * serializeValue({ foo: 'bar' }) → '{"foo":"bar"}'
 */
export const serializeValue = (value: any): string | null => {
  if (value === null || value === undefined) {
    return null
  }

  // Store strings as-is without JSON encoding for cleaner storage
  if (typeof value === 'string') {
    return value
  }

  // Everything else uses JSON
  return JSON.stringify(value)
}

/**
 * Deserialize a stored string value to its typed representation
 * Can optionally accept a type hint for more accurate deserialization
 *
 * @param value - The stored string value
 * @param typeHint - Optional type constructor (String, Boolean, Number) to guide deserialization
 *
 * @example
 * deserializeValue('hello', String) → 'hello'
 * deserializeValue('42', Number) → 42
 * deserializeValue('true', Boolean) → true
 * deserializeValue('{"foo":"bar"}') → { foo: 'bar' }
 */
export const deserializeValue = (
  value: string | null | undefined,
  typeHint?: StringConstructor | BooleanConstructor | NumberConstructor,
): unknown => {
  if (value === null || value === undefined) {
    return null
  }

  // If we have a type hint, use it for direct deserialization
  if (typeHint === String) {
    return value
  }
  if (typeHint === Boolean) {
    return value === 'true'
  }
  if (typeHint === Number) {
    const num = Number(value)
    return Number.isNaN(num) ? value : num
  }

  // Without type hint, try JSON parsing (handles booleans, numbers, objects, arrays)
  try {
    return JSON.parse(value)
  } catch {
    // If parsing fails, it's a plain string - return as-is
    return value
  }
}
