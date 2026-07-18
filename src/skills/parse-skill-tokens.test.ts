/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  deleteSkillTokenAt,
  findSkillTokens,
  normalizeSkillTokensToSlugs,
  parseSkillTokens,
  type SkillResolver,
} from './parse-skill-tokens'

const library: Record<string, string> = {
  'meeting-notes': 'You are a meeting-notes summarizer.',
  'weekly-review': 'You are a weekly review coach.',
  'task-triage': 'You are a triage assistant.',
}

const disabled = new Set<string>(['task-triage'])

const resolve: SkillResolver = (slug) => {
  if (disabled.has(slug)) {
    return null
  }
  const instruction = library[slug]
  return instruction ? { instruction } : null
}

describe('parseSkillTokens', () => {
  it('returns user text unchanged in all cases', () => {
    const inputs = ['', 'hello', '/meeting-notes hi', '/foo hi /bar there']
    for (const text of inputs) {
      expect(parseSkillTokens(text, resolve).text).toBe(text)
    }
  })

  it('emits no system messages when no tokens are present', () => {
    expect(parseSkillTokens('just a plain message', resolve).systemMessages).toEqual([])
  })

  it('emits one system message for a single resolved token', () => {
    const { systemMessages } = parseSkillTokens('/meeting-notes summarize this', resolve)
    expect(systemMessages).toEqual([library['meeting-notes']!])
  })

  it('emits one system message per unique resolved skill, in first-seen order', () => {
    const { systemMessages } = parseSkillTokens('/weekly-review then /meeting-notes', resolve)
    expect(systemMessages).toEqual([library['weekly-review']!, library['meeting-notes']!])
  })

  it('dedupes duplicate tokens to a single system message', () => {
    const { systemMessages } = parseSkillTokens('/meeting-notes then again /meeting-notes', resolve)
    expect(systemMessages).toEqual([library['meeting-notes']!])
  })

  it('skips unknown tokens silently (literal text reaches the model)', () => {
    const { text, systemMessages } = parseSkillTokens('hello /not-a-skill world', resolve)
    expect(text).toBe('hello /not-a-skill world')
    expect(systemMessages).toEqual([])
  })

  it('skips disabled skills', () => {
    const { systemMessages } = parseSkillTokens('/task-triage me', resolve)
    expect(systemMessages).toEqual([])
  })

  it('matches tokens at the start, middle, and end of the input', () => {
    expect(parseSkillTokens('/meeting-notes paste', resolve).systemMessages).toHaveLength(1)
    expect(parseSkillTokens('please /meeting-notes paste', resolve).systemMessages).toHaveLength(1)
    expect(parseSkillTokens('please paste /meeting-notes', resolve).systemMessages).toHaveLength(1)
  })

  it('matches tokens separated by newlines', () => {
    const { systemMessages } = parseSkillTokens('first line\n/meeting-notes\nsecond line', resolve)
    expect(systemMessages).toEqual([library['meeting-notes']!])
  })

  it('matches hyphenated tokens', () => {
    expect(parseSkillTokens('/weekly-review please', resolve).systemMessages).toEqual([library['weekly-review']!])
  })

  it('preserves first-seen order with a mix of resolved and unresolved tokens', () => {
    const { systemMessages } = parseSkillTokens('/not-real /meeting-notes /also-not-real /weekly-review', resolve)
    expect(systemMessages).toEqual([library['meeting-notes']!, library['weekly-review']!])
  })

  it('does not match tokens followed by punctuation (sentence-final period)', () => {
    // `/meeting-notes.` — period is not whitespace or end-of-input, so the regex
    // shouldn't consume "meeting-notes" + "." as a token. Spec §4 regex.
    expect(parseSkillTokens('check /meeting-notes.', resolve).systemMessages).toEqual([])
  })

  it('does not match bare slashes or non-slug fragments', () => {
    expect(parseSkillTokens('what / is this', resolve).systemMessages).toEqual([])
    expect(parseSkillTokens('a/b/c', resolve).systemMessages).toEqual([])
  })

  it('does not match slash tokens inside URLs or paths', () => {
    // `/meeting-notes` is a known skill, but it appears mid-URL — the parser
    // must not resolve it, otherwise prose containing arbitrary URLs would
    // silently inject skill instructions.
    expect(parseSkillTokens('see docs/meeting-notes for details', resolve).systemMessages).toEqual([])
    expect(parseSkillTokens('visit https://example.com/meeting-notes', resolve).systemMessages).toEqual([])
    expect(parseSkillTokens('path/meeting-notes ', resolve).systemMessages).toEqual([])
  })

  it('passes the bare slug (no leading slash) to the resolver', () => {
    const calls: string[] = []
    parseSkillTokens('/meeting-notes', (slug) => {
      calls.push(slug)
      return null
    })
    expect(calls).toEqual(['meeting-notes'])
  })
})

describe('findSkillTokens', () => {
  it('reports each token with start/end positions and bare slug', () => {
    expect(findSkillTokens('hi /meeting-notes there')).toEqual([
      { slug: 'meeting-notes', start: 3, end: 17, committed: true, isDisplay: false },
    ])
  })

  it('reports duplicates separately (no dedupe — caller decides)', () => {
    const tokens = findSkillTokens('/a then /a')
    expect(tokens.map((t) => t.slug)).toEqual(['a', 'a'])
  })

  it('returns an empty list when there are no tokens', () => {
    expect(findSkillTokens('plain text')).toEqual([])
  })

  it('flags a token at end-of-input as not committed (still typing)', () => {
    const tokens = findSkillTokens('hello /meeting')
    expect(tokens).toEqual([{ slug: 'meeting', start: 6, end: 14, committed: false, isDisplay: false }])
  })

  it('flags a token followed by whitespace as committed', () => {
    const tokens = findSkillTokens('hello /meeting hi')
    expect(tokens[0]?.committed).toBe(true)
  })

  it('flags a token followed by a newline as committed', () => {
    const tokens = findSkillTokens('/meeting\nnext')
    expect(tokens[0]?.committed).toBe(true)
  })

  it('marks earlier tokens committed when only the last one is in-progress', () => {
    const tokens = findSkillTokens('/a then /b')
    expect(tokens.map((t) => t.committed)).toEqual([true, false])
  })
})

describe('display-title tokens', () => {
  const titles = new Map([
    ['Daily Brief', 'daily-brief'],
    ['Daily Brief Extended', 'daily-brief-extended'],
  ])

  it('matches a multi-word display token and maps it to its slug', () => {
    expect(findSkillTokens('run /Daily Brief now', titles)).toEqual([
      { slug: 'daily-brief', start: 4, end: 16, committed: true, isDisplay: true },
    ])
  })

  it('prefers the longest matching title', () => {
    const tokens = findSkillTokens('/Daily Brief Extended please', titles)
    expect(tokens[0]?.slug).toBe('daily-brief-extended')
  })

  it('requires a boundary after the title (no partial-word match)', () => {
    // "Briefing" ≠ "Brief" — the char after the candidate must be whitespace/end.
    expect(findSkillTokens('/Daily Briefing now', titles)).toEqual([
      // Falls back to the single-word slug grammar: "/Daily".
      { slug: 'Daily', start: 0, end: 6, committed: true, isDisplay: false },
    ])
  })

  it('still matches plain slug tokens alongside display tokens', () => {
    const tokens = findSkillTokens('/daily-brief and /Daily Brief', titles)
    expect(tokens.map((t) => t.slug)).toEqual(['daily-brief', 'daily-brief'])
  })

  it('does not match display tokens mid-word (URLs/paths)', () => {
    expect(findSkillTokens('see docs/Daily Brief', titles)).toEqual([])
  })
})

describe('deleteSkillTokenAt', () => {
  const titles = new Map([['Daily Brief', 'daily-brief']])
  const text = 'run /Daily Brief now' // token spans [4, 16)

  it('deletes the whole display token when the caret is at its end', () => {
    expect(deleteSkillTokenAt(text, 16, titles)).toEqual({ text: 'run  now', caret: 4 })
  })

  it('deletes the whole display token when the caret is inside it', () => {
    expect(deleteSkillTokenAt(text, 10, titles)).toEqual({ text: 'run  now', caret: 4 })
  })

  it('returns null when the caret is just before the token (backspace eats the preceding char)', () => {
    expect(deleteSkillTokenAt(text, 4, titles)).toBeNull()
  })

  it('returns null when the caret is past the token (e.g. after the trailing space)', () => {
    expect(deleteSkillTokenAt(text, 17, titles)).toBeNull()
  })

  it('leaves hand-typed slug tokens alone (letter-by-letter editing)', () => {
    expect(deleteSkillTokenAt('run /daily-brief now', 16, titles)).toBeNull()
  })

  it('returns null in plain text', () => {
    expect(deleteSkillTokenAt('no tokens here', 5, titles)).toBeNull()
  })
})

describe('normalizeSkillTokensToSlugs', () => {
  const titles = new Map([['Daily Brief', 'daily-brief']])

  it('rewrites display tokens to slug form', () => {
    expect(normalizeSkillTokensToSlugs('run /Daily Brief now', titles)).toBe('run /daily-brief now')
  })

  it('leaves slug tokens and plain text untouched', () => {
    expect(normalizeSkillTokensToSlugs('run /daily-brief now', titles)).toBe('run /daily-brief now')
    expect(normalizeSkillTokensToSlugs('no tokens here', titles)).toBe('no tokens here')
  })

  it('rewrites every occurrence', () => {
    expect(normalizeSkillTokensToSlugs('/Daily Brief then /Daily Brief', titles)).toBe('/daily-brief then /daily-brief')
  })

  it('leaves unknown tokens as typed', () => {
    expect(normalizeSkillTokensToSlugs('try /Unknown Thing', titles)).toBe('try /Unknown Thing')
  })
})
