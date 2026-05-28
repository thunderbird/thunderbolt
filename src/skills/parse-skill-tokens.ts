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

/**
 * Iterate over the raw slash tokens in `text` without resolving them.
 * Useful for the highlight overlay and slash autocomplete, which want token
 * positions but compute their own resolution decision.
 *
 * `committed` is true when the token is followed by whitespace (the user
 * has finished typing it). It is false when the token sits at the very
 * end of `text` — the user is likely still typing.
 */
export const findSkillTokens = (
  text: string,
): Array<{ slug: string; start: number; end: number; committed: boolean }> => {
  const tokens: Array<{ slug: string; start: number; end: number; committed: boolean }> = []
  for (const match of text.matchAll(tokenRegex)) {
    const slug = match[1]
    if (slug === undefined || match.index === undefined) {
      continue
    }
    const end = match.index + match[0].length
    const committed = end < text.length // i.e., the lookahead matched whitespace, not $
    tokens.push({ slug, start: match.index, end, committed })
  }
  return tokens
}
