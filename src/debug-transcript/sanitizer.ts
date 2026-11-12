/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { JsonValue } from './types'

const redacted = '[redacted]'
const sensitiveKeyFragments = [
  'apikey',
  'authorization',
  'cookie',
  'secret',
  'password',
  'passphrase',
  'privatekey',
  'credential',
  'pwd',
]
const privateKeyPattern = /-----BEGIN ((?:[A-Z0-9]+ )?PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gi
const credentialAssignmentPattern =
  /([?&])?\b(?:aws[-_ ]*secret[-_ ]*access[-_ ]*key|client[-_ ]*secret)(?:\\*["'])?\s*[:=]\s*/gi

/** Find a quoted value's end without backtracking, including JSON-escaped delimiters. */
const quotedCredentialEnd = (value: string, start: number, delimiter: string): number => {
  const quote = delimiter.at(-1)
  // Each JSON wrapping doubles escape runs: closing quotes recur every 2 * (escaped + 1) backslashes.
  const escaped = delimiter.length - 1
  let backslashes = 0
  for (let index = start + delimiter.length; index < value.length; index++) {
    const character = value[index]
    if (character === quote && backslashes >= escaped && (backslashes - escaped) % (2 * (escaped + 1)) === 0) {
      return index + 1
    }
    backslashes = character === '\\' ? backslashes + 1 : 0
  }
  // A truncated log or note must not expose the unfinished credential.
  return value.length
}

/** Redact labeled assignments while preserving surrounding text and quote delimiters. */
const redactCredentialAssignments = (value: string): string => {
  const chunks: string[] = []
  let cursor = 0
  for (const match of value.matchAll(credentialAssignmentPattern)) {
    if (match.index < cursor) {
      continue
    }
    const start = match.index + match[0].length
    const remaining = value.slice(start)
    const delimiter = /^\\*["'`]/.exec(remaining)?.[0] ?? ''
    // URL-style parameters keep their separators; bare opaque secrets may contain punctuation.
    const bareValue = match[1] ? /^[^&#\s]*/ : /^\S*/
    const end = delimiter
      ? quotedCredentialEnd(value, start, delimiter)
      : start + (bareValue.exec(remaining)?.[0].length ?? 0)
    if (end === start) {
      continue
    }
    chunks.push(value.slice(cursor, start), `${delimiter}${redacted}${delimiter}`)
    cursor = end
  }
  chunks.push(value.slice(cursor))
  return chunks.join('')
}

const jwtPattern = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]{5,})?\b/g
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const skProviderKeyPattern = /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/gi
const knownProviderKeyPattern =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,}|pplx-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,})\b/gi
const urlCredentialQueryPattern =
  /([?&](?:access_token|refresh_token|id_token|token|key|api_key|client_secret|code|assertion|signature|sig|password)=)[^&#\s]*/gi
const urlUserInfoPattern = /(\b[a-z][a-z0-9+.-]*:\/\/)[^:/@\s]+:[^/@\s]+@/gi

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.replace(/[-_\s]/g, '').toLowerCase()
  // Pagination cursors also end in "token"; redacting them is safe and may hide signed material.
  return normalized.endsWith('token') || sensitiveKeyFragments.some((fragment) => normalized.includes(fragment))
}

/** Redact credentials embedded in free-form transcript text. */
export const sanitizeDebugTranscriptText = (value: string): string =>
  [jwtPattern, bearerPattern, skProviderKeyPattern, knownProviderKeyPattern]
    .reduce(
      (sanitized, pattern) => sanitized.replace(pattern, redacted),
      redactCredentialAssignments(value.replace(privateKeyPattern, redacted)),
    )
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
