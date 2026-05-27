/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { findSkillTokens, parseSkillTokens, type SkillResolver } from './parse-skill-tokens'

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
      { slug: 'meeting-notes', start: 3, end: 17, committed: true },
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
    expect(tokens).toEqual([{ slug: 'meeting', start: 6, end: 14, committed: false }])
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
