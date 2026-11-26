/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

/** Whether `value` is a plain object, not null or an array. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One field an event changed. */
export type AuditFieldChange = { field: string; from: unknown; to: unknown }

/**
 * An event's `changes` as one entry per field, when they're in the `{ field: { from, to } }` shape the
 * backend writes. Null for any other shape, which the panel shows as raw data.
 */
export const auditFieldChanges = (changes: unknown): AuditFieldChange[] | null => {
  if (!isRecord(changes)) {
    return null
  }
  const entries = Object.entries(changes)
  if (entries.length === 0 || !entries.every(([, change]) => isRecord(change) && 'from' in change && 'to' in change)) {
    return null
  }
  return entries.map(([field, change]) => {
    const { from, to } = change as { from: unknown; to: unknown }
    return { field, from, to }
  })
}

/** An event's free-form data as its key-value pairs, or null when it isn't a non-empty object. */
export const auditDataEntries = (data: unknown): [string, unknown][] | null => {
  if (!isRecord(data)) {
    return null
  }
  const entries = Object.entries(data)
  return entries.length > 0 ? entries : null
}

/** A recorded value as text: a string as it is, anything else (numbers, booleans, lists, null) as JSON. */
export const formatAuditValue = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value ?? null)
