/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Exact-text replacement engine for the browser `edit` tool, ported from Pi's
 * `core/tools/edit-diff.ts` (the matching/applying half only — the `diff`-based
 * preview rendering and the `node:fs` preview helper are dropped because the app
 * never renders the edit tool's diff details).
 *
 * The matcher tries an exact match first, then a fuzzy match (NFKC + trailing-
 * whitespace + smart-quote/dash/space normalization) so the model's `oldText`
 * still lands when it differs only in invisible/cosmetic characters. All edits in
 * a call are matched against the SAME original content and applied in reverse
 * offset order so earlier edits cannot shift later offsets. Errors mirror Pi's
 * wording verbatim — the model is tuned to recover from these exact messages.
 *
 * Every function here is pure string manipulation: no Node builtins, no `Buffer`.
 */

/** A single exact-text replacement requested by the model. */
export type EditReplacement = { oldText: string; newText: string }

/** Normalize all line endings to LF. */
export const normalizeToLF = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

/** Detect whether the original content predominantly used CRLF or LF endings. */
export const detectLineEnding = (content: string): '\r\n' | '\n' => {
  const crlfIdx = content.indexOf('\r\n')
  const lfIdx = content.indexOf('\n')
  if (lfIdx === -1) {
    return '\n'
  }
  if (crlfIdx === -1) {
    return '\n'
  }
  return crlfIdx < lfIdx ? '\r\n' : '\n'
}

/** Restore the original line ending after editing in LF space. */
export const restoreLineEndings = (text: string, ending: '\r\n' | '\n'): string =>
  ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text

/** Strip a leading UTF-8 BOM, returning it separately so it can be re-applied. */
export const stripBom = (content: string): { bom: string; text: string } =>
  content.startsWith('\uFEFF') ? { bom: '\uFEFF', text: content.slice(1) } : { bom: '', text: content }

/**
 * Normalize text for fuzzy matching: NFKC, strip per-line trailing whitespace,
 * and fold smart quotes / Unicode dashes / exotic spaces to their ASCII forms.
 */
export const normalizeForFuzzyMatch = (text: string): string =>
  text
    .normalize('NFKC')
    // Strip trailing whitespace per line.
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    // Smart single quotes -> '
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    // Smart double quotes -> "
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // Hyphens/dashes/minus -> -
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    // Exotic spaces -> regular space
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')

type LineSpan = { start: number; end: number }

type MatchedEdit = { editIndex: number; matchIndex: number; matchLength: number; newText: string }

/** Split content into lines, preserving each line's trailing newline. */
const splitLinesWithEndings = (content: string): string[] => content.match(/[^\n]*\n|[^\n]+/g) ?? []

/** Compute the character span of each line within `content`. */
const getLineSpans = (content: string): LineSpan[] => {
  let offset = 0
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length }
    offset = span.end
    return span
  })
}

/** Find the inclusive-exclusive line range a replacement touches within `lines`. */
const getReplacementLineRange = (
  lines: LineSpan[],
  replacement: MatchedEdit,
): { startLine: number; endLine: number } => {
  const replacementStart = replacement.matchIndex
  const replacementEnd = replacement.matchIndex + replacement.matchLength
  let startLine = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i
      break
    }
  }
  if (startLine === -1) {
    throw new Error('Replacement range is outside the base content.')
  }
  let endLine = startLine
  while (endLine < lines.length && lines[endLine].end < replacementEnd) {
    endLine++
  }
  if (endLine >= lines.length) {
    throw new Error('Replacement range is outside the base content.')
  }
  return { startLine, endLine: endLine + 1 }
}

/** Apply replacements (in reverse offset order) to `content`. */
const applyReplacements = (content: string, replacements: MatchedEdit[], offset = 0): string => {
  let result = content
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]
    const matchIndex = replacement.matchIndex - offset
    result =
      result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength)
  }
  return result
}

/**
 * Apply replacements matched against a normalized `baseContent` to the original
 * content while preserving unchanged line blocks byte-for-byte. Used when fuzzy
 * matching rewrote the matching space.
 */
const applyReplacementsPreservingUnchangedLines = (
  originalContent: string,
  baseContent: string,
  replacements: MatchedEdit[],
): string => {
  const originalLines = splitLinesWithEndings(originalContent)
  const baseLines = getLineSpans(baseContent)
  if (originalLines.length !== baseLines.length) {
    throw new Error('Cannot preserve unchanged lines because the base content has a different line count.')
  }
  const groups: { startLine: number; endLine: number; replacements: MatchedEdit[] }[] = []
  const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement)
    const current = groups[groups.length - 1]
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine)
      current.replacements.push(replacement)
      continue
    }
    groups.push({ ...range, replacements: [replacement] })
  }
  let originalLineIndex = 0
  let result = ''
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join('')
    const groupStartOffset = baseLines[group.startLine].start
    const groupEndOffset = baseLines[group.endLine - 1].end
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset,
    )
    originalLineIndex = group.endLine
  }
  result += originalLines.slice(originalLineIndex).join('')
  return result
}

type FuzzyMatch = {
  found: boolean
  index: number
  matchLength: number
  usedFuzzyMatch: boolean
}

/** Find `oldText` in `content`, exact first then fuzzy-normalized. */
const fuzzyFindText = (content: string, oldText: string): FuzzyMatch => {
  const exactIndex = content.indexOf(oldText)
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false }
  }
  const fuzzyContent = normalizeForFuzzyMatch(content)
  const fuzzyOldText = normalizeForFuzzyMatch(oldText)
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText)
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false }
  }
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true }
}

/** Count fuzzy occurrences of `oldText` in `content`. */
const countOccurrences = (content: string, oldText: string): number => {
  const fuzzyContent = normalizeForFuzzyMatch(content)
  const fuzzyOldText = normalizeForFuzzyMatch(oldText)
  return fuzzyContent.split(fuzzyOldText).length - 1
}

const getNotFoundError = (path: string, editIndex: number, totalEdits: number): Error =>
  totalEdits === 1
    ? new Error(
        `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
      )
    : new Error(
        `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
      )

const getDuplicateError = (path: string, editIndex: number, totalEdits: number, occurrences: number): Error =>
  totalEdits === 1
    ? new Error(
        `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
      )
    : new Error(
        `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
      )

const getEmptyOldTextError = (path: string, editIndex: number, totalEdits: number): Error =>
  totalEdits === 1
    ? new Error(`oldText must not be empty in ${path}.`)
    : new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`)

const getNoChangeError = (path: string, totalEdits: number): Error =>
  totalEdits === 1
    ? new Error(
        `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
      )
    : new Error(`No changes made to ${path}. The replacements produced identical content.`)

/**
 * Apply one or more exact-text replacements to LF-normalized content. Throws Pi's
 * exact error messages on empty/missing/duplicate/overlapping/no-op edits.
 *
 * @param normalizedContent - the file content, already normalized to LF
 * @param edits - the replacements to apply
 * @param path - the file path, only used to build human error messages
 * @returns the original (`baseContent`) and edited (`newContent`) content
 */
export const applyEditsToNormalizedContent = (
  normalizedContent: string,
  edits: readonly EditReplacement[],
  path: string,
): { baseContent: string; newContent: string } => {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }))
  for (let i = 0; i < normalizedEdits.length; i++) {
    // Guard against the FUZZY-normalized length, not the raw LF length: a
    // whitespace-only oldText is non-empty after LF normalization but collapses
    // to '' under normalizeForFuzzyMatch (which trims trailing whitespace per
    // line), and a fuzzy match of '' would otherwise land at index 0.
    if (normalizeForFuzzyMatch(normalizedEdits[i].oldText).length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length)
    }
  }
  const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText))
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch)
  const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent
  const matchedEdits: MatchedEdit[] = []
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i]
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText)
    if (!matchResult.found) {
      throw getNotFoundError(path, i, normalizedEdits.length)
    }
    const occurrences = countOccurrences(replacementBaseContent, edit.oldText)
    if (occurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, occurrences)
    }
    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    })
  }
  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex)
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1]
    const current = matchedEdits[i]
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      )
    }
  }
  const baseContent = normalizedContent
  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
    : applyReplacements(replacementBaseContent, matchedEdits)
  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length)
  }
  return { baseContent, newContent }
}
