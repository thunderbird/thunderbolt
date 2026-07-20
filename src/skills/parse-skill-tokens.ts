/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Slash-token grammar: `/` followed by one or more `[a-z0-9-_]` chars,
 * matched only when *preceded* by whitespace or start-of-input AND
 * terminated by whitespace or end-of-input. Mirrors the AgentSkills spec
 * name field — the parser intentionally does **not** match tokens followed
 * by punctuation (`/foo.`) so a sentence-final period in prose doesn't
 * accidentally consume the trailing char of the name.
 *
 * The lookbehind prevents `/slug` matches inside URLs or paths
 * (e.g. `docs/meeting-notes`, `example.com/meeting-notes`) — without it,
 * the parser would silently inject skill instructions for tokens the user
 * never actually typed as commands. The autocomplete popup in
 * `use-slash-command.ts` already requires whitespace before `/`, so this
 * keeps both surfaces in agreement.
 *
 * The captured group is the bare slug (no leading `/`), which is also how
 * skills are stored after THU-533 (the `/` is display only).
 */
const tokenRegex = /(?<=^|\s)\/([\w-]+)(?=\s|$)/g

/**
 * Resolve a bare slug to a skill's instruction text, or `null` if the slug
 * doesn't name an enabled skill in the user's library.
 */
export type SkillResolver = (slug: string) => { instruction: string } | null

export type ParsedSkills = {
  /** The user's original text, untouched — sent to the model verbatim. */
  text: string
  /**
   * One ephemeral system message per unique resolved skill, in first-seen
   * order. Each message's content is the skill's `instruction`. Unresolved
   * tokens (unknown or disabled) contribute nothing — they remain part of
   * `text` and reach the model as literal characters.
   */
  systemMessages: string[]
}

/**
 * Parse slash tokens out of a user message, dedupe by slug, and produce one
 * system message per unique resolved skill.
 *
 * Per the Skills v1 spec, this runs at every send / regenerate: nothing
 * about the resolution is persisted; the user's original text carries the
 * slash tokens forward and re-resolution picks up whatever the user's
 * library looks like at replay time.
 *
 * @see {@link https://github.com/thunderbird/thunderbolt-spec/blob/spec/skillsv1/specs/skills-v1.md#4-chat-skill-resolution-on-send Skills v1 §4}
 */
export const parseSkillTokens = (text: string, resolve: SkillResolver): ParsedSkills => {
  const seen = new Set<string>()
  const systemMessages: string[] = []
  for (const match of text.matchAll(tokenRegex)) {
    const slug = match[1]
    if (!slug || seen.has(slug)) {
      continue
    }
    seen.add(slug)
    const resolved = resolve(slug)
    if (resolved) {
      systemMessages.push(resolved.instruction)
    }
  }
  return { text, systemMessages }
}

export type SkillTokenMatch = {
  /** The bare slug the token resolves to (display tokens are mapped through `displayNameToSlug`). */
  slug: string
  start: number
  end: number
  committed: boolean
  /** True for display-title tokens (`/Daily Brief`) — the chips the composer
   *  inserts. False for hand-typed slug tokens (`/daily-brief`). */
  isDisplay: boolean
}

const isBoundary = (text: string, index: number): boolean => index >= text.length || /\s/.test(text[index])

/**
 * Iterate over the raw slash tokens in `text` without resolving them.
 * Useful for the highlight overlay and slash autocomplete, which want token
 * positions but compute their own resolution decision.
 *
 * Two token shapes are recognized:
 * - **Display tokens** — `/` followed by a known skill display name from
 *   `displayNameToSlug` (may contain spaces / arbitrary chars, matched
 *   longest-first, terminated by whitespace or end). This is what the
 *   composer inserts, so the user reads titles while the model ultimately
 *   receives slugs (see {@link normalizeSkillTokensToSlugs}).
 * - **Slug tokens** — the original `/[\w-]+` grammar, still valid for
 *   hand-typed slugs and agent commands.
 *
 * `committed` is true when the token is followed by whitespace (the user
 * has finished typing it). It is false when the token sits at the very
 * end of `text` — the user is likely still typing.
 */
export const findSkillTokens = (text: string, displayNameToSlug?: ReadonlyMap<string, string>): SkillTokenMatch[] => {
  // [name, slug] pairs, longest name first so "Daily Brief Extended" wins
  // over "Daily Brief". Carrying the slug alongside the name avoids a
  // second map lookup after a match.
  const displayEntries = displayNameToSlug
    ? [...displayNameToSlug.entries()].filter(([name]) => name.length > 0).sort(([a], [b]) => b.length - a.length)
    : []
  const tokens: SkillTokenMatch[] = []
  let i = 0
  while (i < text.length) {
    const isTokenStart = text[i] === '/' && (i === 0 || /\s/.test(text[i - 1]))
    if (!isTokenStart) {
      i++
      continue
    }
    const entry = displayEntries.find(([name]) => text.startsWith(name, i + 1) && isBoundary(text, i + 1 + name.length))
    if (entry) {
      const [name, slug] = entry
      const end = i + 1 + name.length
      tokens.push({ slug, start: i, end, committed: end < text.length, isDisplay: true })
      i = end
      continue
    }
    const slugMatch = /^[\w-]+/.exec(text.slice(i + 1))
    if (slugMatch && isBoundary(text, i + 1 + slugMatch[0].length)) {
      const end = i + 1 + slugMatch[0].length
      tokens.push({ slug: slugMatch[0], start: i, end, committed: end < text.length, isDisplay: false })
      i = end
      continue
    }
    i++
  }
  return tokens
}

/**
 * Chip-style backspace: when `caret` sits inside or immediately after a
 * display-title token (`/Daily Brief`), return `text` with the whole token
 * removed and the caret collapsed to where the token began. Hand-typed slug
 * tokens are left alone — they were typed letter by letter, so they stay
 * editable letter by letter. Returns `null` when the caret doesn't touch a
 * display token (caller falls through to the default backspace).
 */
export const deleteSkillTokenAt = (
  text: string,
  caret: number,
  displayNameToSlug: ReadonlyMap<string, string>,
): { text: string; caret: number } | null => {
  const token = findSkillTokens(text, displayNameToSlug).find((t) => t.isDisplay && caret > t.start && caret <= t.end)
  if (!token) {
    return null
  }
  return { text: text.slice(0, token.start) + text.slice(token.end), caret: token.start }
}

/**
 * Rewrite display tokens (`/Daily Brief`) in `text` to their canonical slug
 * form (`/daily-brief`). Run at send time so the composer can show human
 * titles while the model — and the stored message — only ever sees slugs.
 * Slug tokens and unrecognized text pass through untouched.
 */
export const normalizeSkillTokensToSlugs = (text: string, displayNameToSlug: ReadonlyMap<string, string>): string => {
  const tokens = findSkillTokens(text, displayNameToSlug)
  if (tokens.length === 0) {
    return text
  }
  let result = ''
  let cursor = 0
  for (const { slug, start, end } of tokens) {
    result += text.slice(cursor, start) + `/${slug}`
    cursor = end
  }
  return result + text.slice(cursor)
}
