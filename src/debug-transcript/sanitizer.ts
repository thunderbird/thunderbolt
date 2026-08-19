/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { JsonValue } from './types'

const redacted = '[redacted]'
const sensitiveKeyFragments = ['apikey', 'authorization', 'cookie', 'secret', 'password']
const jwtPattern = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]{5,})?\b/g
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const skProviderKeyPattern = /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/gi
const knownProviderKeyPattern =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,}|pplx-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,})\b/gi
const urlCredentialQueryPattern = /([?&](?:access_token|token|key|api_key|signature|sig|password)=)[^&#\s]*/gi
const urlUserInfoPattern = /(\b[a-z][a-z0-9+.-]*:\/\/)[^:/@\s]+:[^/@\s]+@/gi

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.replace(/[-_\s]/g, '').toLowerCase()
  // Pagination cursors also end in "token"; redacting them is safe and may hide signed material.
  return normalized.endsWith('token') || sensitiveKeyFragments.some((fragment) => normalized.includes(fragment))
}

/** Redact credentials embedded in free-form transcript text. */
export const sanitizeDebugTranscriptText = (value: string): string =>
  [jwtPattern, bearerPattern, skProviderKeyPattern, knownProviderKeyPattern]
    .reduce((sanitized, pattern) => sanitized.replace(pattern, redacted), value)
    .replace(urlCredentialQueryPattern, `$1${redacted}`)
    .replace(urlUserInfoPattern, `$1${redacted}:${redacted}@`)

const sanitizeValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue)
  }
  const valueTag = Object.prototype.toString.call(value)
  if (valueTag === '[object String]') {
    return sanitizeDebugTranscriptText(value as string)
  }
  if (valueTag !== '[object Object]') {
    return value
  }
  const objectValue = value as { [key: string]: JsonValue }
  return Object.fromEntries(
    Object.entries(objectValue).map(([key, nestedValue]) => [
      key,
      isSensitiveKey(key) ? redacted : sanitizeValue(nestedValue),
    ]),
  )
}

/**
 * Clone a JSON tree and redact credentials without anonymizing its people.
 * Stripping secrets is security, not anonymity: emails, names, and ordinary
 * user-authored content remain intact because debug transcripts are identified.
 */
export const sanitizeDebugTranscriptSecrets = <Value extends JsonValue>(value: Value): Value =>
  sanitizeValue(value) as Value
