/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@lingui/core'
import { describe, expect, test } from 'bun:test'
import { defaultChatTitle } from './constants'
import { chatTitleLabel, generateTitle } from './title-generator'

/**
 * Whether `text` is valid UTF-16 — no half of a surrogate pair left on its own.
 * `String.prototype.isWellFormed` would say this in one call, but it needs an
 * `es2024` lib target and the project builds against an earlier one.
 */
const isWellFormed = (text: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)

/** The character budget in title-generator.ts, which does not export it. */
const budget = 48

/**
 * Whether `title` is the *longest* prefix of `source` that both ends on a word
 * and fits the budget, checked against a fresh segmenter rather than the
 * generator's own.
 *
 * Which word a dictionary script breaks on is ICU data, so pinning the cut
 * character-for-character would fail the day a platform ships a newer ICU.
 * Asserting only "ends on some boundary" is too weak in the other direction —
 * an implementation that stopped at the first word would satisfy it — so the
 * cut is required to be maximal, which is the actual contract.
 */
const cutsMaximallyOnWordBoundary = (source: string, title: string, locale: string): boolean => {
  const wordEnds = [...new Intl.Segmenter(locale, { granularity: 'word' }).segment(source)]
    .filter((part) => part.isWordLike === true)
    .map((part) => part.index + part.segment.length)
    .filter((end) => end <= budget)

  return wordEnds.at(-1) === title.length
}

describe('generateTitle', () => {
  test('keeps a short message verbatim', () => {
    expect(generateTitle('Fix the CI failure on iOS')).toBe('Fix the CI failure on iOS')
  })

  test('preserves the casing the user typed', () => {
    expect(generateTitle('PowerSync sync rules keep dropping ci.yml')).toBe('PowerSync sync rules keep dropping ci.yml')
  })

  test('does not eat a word that merely starts with an opener', () => {
    expect(generateTitle('Highlight the failing tests')).toBe('Highlight the failing tests')
    expect(generateTitle('Whatsapp integration for mobile')).toBe('Whatsapp integration for mobile')
  })

  test('cuts a long message on a word boundary', () => {
    const title = generateTitle('Rewrite the chat title generator so that it segments unspaced scripts correctly')
    expect(title).toBe('Rewrite the chat title generator so that it')
    expect(title.length).toBeLessThanOrEqual(budget)
  })

  test('cuts Japanese on a word rather than mid-word, and adds no spaces', () => {
    const source =
      'PowerSyncの同期ルールを修正する方法を教えてください。これは長い日本語の文章です。もう少し長くします。'
    const title = generateTitle(source)

    expect(source).toStartWith(title)
    expect(title.length).toBeLessThanOrEqual(budget)
    expect(title).not.toContain(' ')
    expect(cutsMaximallyOnWordBoundary(source, title, 'ja')).toBe(true)
  })

  test('cuts Thai on a word boundary', () => {
    const source = 'ฉันต้องการแก้ไขกฎการซิงค์ของฐานข้อมูลเพราะมันใช้งานไม่ได้เลยในตอนนี้'
    const title = generateTitle(source)

    expect(source).toStartWith(title)
    expect(title.length).toBeLessThanOrEqual(budget)
    expect(cutsMaximallyOnWordBoundary(source, title, 'th')).toBe(true)
  })

  test('collapses newlines and surrounding whitespace', () => {
    expect(generateTitle('  Fix the login bug\n\nthen deploy  ')).toBe('Fix the login bug then deploy')
  })

  test('falls back to the sentinel when the message holds no text', () => {
    expect(generateTitle('')).toBe(defaultChatTitle)
    expect(generateTitle('   \n  ')).toBe(defaultChatTitle)
  })

  test('keeps a message of exactly the budget length intact', () => {
    const source = 'a'.repeat(budget)
    expect(generateTitle(source)).toBe(source)
  })

  test('cuts mixed-script text on a word boundary', () => {
    const title = generateTitle('Fix the 同期ルール bug in the PowerSync client before the release')
    expect(title).toBe('Fix the 同期ルール bug in the PowerSync client before')
  })

  test('never splits a grapheme, so the title is always well-formed', () => {
    // Emoji are not word-like, so a long run of them takes the fallback cut —
    // where a plain slice would leave a lone surrogate in a synced column.
    const title = generateTitle('👨‍👩‍👧‍👦'.repeat(5))

    expect(isWellFormed(title)).toBe(true)
    expect(title.length).toBeLessThanOrEqual(budget)
    expect(title).toBe('👨‍👩‍👧‍👦'.repeat(4))
  })

  test('keeps a combining mark with the letter it modifies', () => {
    // Devanagari: a bare slice can strip the vowel sign off its consonant.
    const source = 'नमस्ते'.repeat(12)
    const title = generateTitle(source)

    expect(isWellFormed(title)).toBe(true)
    expect(source).toStartWith(title)
  })

  test('hard-cuts a single unbroken word that overruns the budget', () => {
    const title = generateTitle('a'.repeat(80))
    expect(title).toBe('a'.repeat(budget))
  })
})

describe('chatTitleLabel', () => {
  test('translates the untitled sentinel rather than storing it per locale', () => {
    // The stored value stays `defaultChatTitle` — it is compared on hydration to
    // decide whether to auto-title, so a localized row would break that.
    expect(chatTitleLabel(i18n, defaultChatTitle)).toBe('New Chat')
  })

  test('falls back for a thread with no title at all', () => {
    expect(chatTitleLabel(i18n, null)).toBe('Untitled chat')
    expect(chatTitleLabel(i18n, undefined)).toBe('Untitled chat')
    expect(chatTitleLabel(i18n, '')).toBe('Untitled chat')
  })

  test('passes a real title through untouched', () => {
    expect(chatTitleLabel(i18n, 'Trip to Berlin')).toBe('Trip to Berlin')
    // A user is free to name a thread after the sentinel's translation; only the
    // sentinel itself is substituted.
    expect(chatTitleLabel(i18n, 'New Chat ideas')).toBe('New Chat ideas')
  })
})
