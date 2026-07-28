/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Turn an assistant text chunk into speakable text (THU-715).
 *
 * The model writes for the eye — markdown, code, emoji, links, tables. Fed raw
 * to TTS that becomes gibberish ("asterisk asterisk", read-aloud code, emoji
 * names). This strips the visual scaffolding down to what a person would
 * actually say, and returns '' for chunks that are nothing but markup/code (so
 * the caller can skip synthesizing them).
 *
 * Runs per aggregated sentence chunk, after the aggregator's sentence splitting.
 */
import type { ContentPart } from '@/ai/widget-parser'

// Emoji, pictographs, regional indicators, plus the variation selector (FE0F),
// ZWJ (200D) and combining enclosing keycap (20E3). The combining/joining code
// points live in alternation branches, not the character class, to avoid the
// no-misleading-character-class rule (combining marks inside `[...]` are flagged).
const emoji = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u{FE0F}|\u{200D}|\u{20E3}/gu

/**
 * Widget tags (`<widget:NAME .../>`) render as rich UI, so reading the raw tag
 * aloud is nonsense. Substantive/interactive widgets become a spoken pointer to
 * the on-screen UI; inline-reference widgets (citation, link-preview) and their
 * bracket markers are dropped — they're visual footnotes, not speech.
 */
const widgetAnnouncement: Record<string, string> = {
  'weather-forecast': 'Take a look at the weather forecast on screen.',
  map: 'Take a look at the map on screen.',
  'connect-integration': 'Use the connection prompt on screen to continue.',
  'document-result': 'See the document on screen.',
  ask: 'Please choose one of the options on screen.',
}

/** Spoken pointer for a widget, or '' for reference-only widgets (citation, link-preview). */
export const announceWidget = (name: string): string => widgetAnnouncement[name.toLowerCase()] ?? ''

/**
 * Flatten parsed content parts into clean speech source: text verbatim, widgets
 * as their spoken announcement, skipping loading placeholders. Widget *internals*
 * (quiz options, JSON, urls) never appear — they live only inside widget parts,
 * which we replace wholesale. Run this on the accumulated reply BEFORE sentence
 * aggregation so a tag full of punctuation can't be split into leaking fragments.
 */
export const partsToSpeech = (parts: ContentPart[]): string =>
  parts
    .map((part) =>
      part.type === 'text' ? part.content : part.type === 'widget' ? announceWidget(part.widget.widget) : '',
    )
    .filter(Boolean)
    .join(' ')

export const toSpeakable = (input: string): string => {
  let text = input

  // Widget tags → a spoken pointer (or dropped for reference widgets). Do this
  // first, before the tag's attribute URLs/quotes get mangled by later passes.
  text = text.replace(/<widget:([\w-]+)[\s\S]*?\/?>/gi, (_m, name: string) => {
    const announcement = announceWidget(name)
    return announcement ? ` ${announcement} ` : ' '
  })
  // Drop any dangling partial widget tag left by mid-stream chunking.
  text = text.replace(/<widget:[\s\S]*$/i, ' ')
  // Inline citation markers (【2†title】, 【3】, [1]) — footnotes, not speech.
  text = text.replace(/【\d+[^】]*】/g, '')
  text = text.replace(/\[\d+\]/g, '')

  // Fenced code blocks — drop entirely (don't read code aloud).
  text = text.replace(/```[\s\S]*?```/g, ' ')
  // Inline code — keep the words, drop the backticks.
  text = text.replace(/`([^`]*)`/g, '$1')
  // LaTeX/math — read aloud it's gibberish ("dollar backslash frac..."). Display
  // math becomes a spoken pointer (it renders in the bubble); inline math and
  // stray commands (\frac{a}{b}, \alpha) are removed. Verbalizing equations
  // properly (LaTeX→speech) is a follow-up.
  text = text.replace(/\$\$[\s\S]*?\$\$/g, ' See the equation on screen. ')
  text = text.replace(/\\\[[\s\S]*?\\\]/g, ' See the equation on screen. ')
  text = text.replace(/\\\([\s\S]*?\\\)/g, ' ')
  // Inline math `$…$` → dropped. The negative lookahead skips a `$` that opens a
  // currency amount ("it costs $5 and $10 apiece"), which would otherwise be
  // mis-read as one math span and mangled; TTS speaks a bare "$5" correctly.
  text = text.replace(/\$(?![\s\d])[^$\n]+\$/g, ' ')
  text = text.replace(/\\[a-zA-Z]+\s*(?:\{[^{}]*\})*/g, ' ')
  // Images: ![alt](url) → drop. Links: [text](url) → text.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // Bare URLs → a short spoken token rather than reading the whole path.
  text = text.replace(/https?:\/\/[^\s)]+/g, 'link')
  // Emphasis / headings / blockquote / list markers / rules / table pipes.
  text = text.replace(/(\*\*|__|\*|_|~~)/g, '')
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  text = text.replace(/^\s{0,3}>\s?/gm, '')
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+\.\s+/gm, '')
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
  text = text.replace(/\|/g, ' ')
  // Emoji + stray symbol noise.
  text = text.replace(emoji, '')
  // Collapse whitespace, then close up any space left before punctuation
  // (e.g. from a removed citation marker: "today [1]." → "today .").
  text = text.replace(/\s+/g, ' ')
  text = text.replace(/\s+([.,!?;:])/g, '$1').trim()

  // If nothing pronounceable survived (letters/digits), skip it.
  return /[\p{L}\p{N}]/u.test(text) ? text : ''
}
