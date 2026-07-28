/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { parseContentParts } from '@/ai/widget-parser'
import { partsToSpeech, toSpeakable } from './speakable'

describe('toSpeakable', () => {
  test('strips bold/italic emphasis, keeps words', () => {
    expect(toSpeakable('This is **really** _very_ important.')).toBe('This is really very important.')
  })

  test('drops fenced code blocks entirely', () => {
    expect(toSpeakable('Here you go:\n```js\nconst x = 1\n```\nThat runs it.')).toBe('Here you go: That runs it.')
  })

  test('keeps inline code words, drops backticks', () => {
    expect(toSpeakable('Call `saveThing()` to save.')).toBe('Call saveThing() to save.')
  })

  test('turns links into their text and bare URLs into "link"', () => {
    expect(toSpeakable('See [the docs](https://x.com/a/b) here.')).toBe('See the docs here.')
    expect(toSpeakable('Go to https://example.com/page now.')).toBe('Go to link now.')
  })

  test('strips headings, list markers, and blockquotes', () => {
    expect(toSpeakable('# Title\n- one\n- two\n> a quote')).toBe('Title one two a quote')
  })

  test('removes emoji (so they are not read as unicode)', () => {
    expect(toSpeakable('Done ✅ and shipped 🚀🎉')).toBe('Done and shipped')
    expect(toSpeakable('Family 👨‍👩‍👧 flag 🇺🇸 here')).toBe('Family flag here')
  })

  test('returns empty for chunks that are only markup/code', () => {
    expect(toSpeakable('```\ncode only\n```')).toBe('')
    expect(toSpeakable('🚀🎉')).toBe('')
    expect(toSpeakable('---')).toBe('')
  })

  test('collapses table pipes and whitespace', () => {
    expect(toSpeakable('| a | b |\n\n\ndone')).toBe('a b done')
  })

  test('announces substantive/interactive widgets instead of reading the tag', () => {
    expect(toSpeakable('Here you go: <widget:weather-forecast location="Seattle" region="WA" country="USA" />')).toBe(
      'Here you go: Take a look at the weather forecast on screen.',
    )
    expect(toSpeakable('<widget:connect-integration provider="google" service="email" reason="" override="" />')).toBe(
      'Use the connection prompt on screen to continue.',
    )
    expect(toSpeakable('<widget:ask question="Pick one" />')).toBe('Please choose one of the options on screen.')
  })

  test('drops inline-reference widgets and citation markers', () => {
    expect(toSpeakable('This is true. <widget:citation sources=\'[{"id":"1"}]\' />')).toBe('This is true.')
    expect(toSpeakable('See more <widget:link-preview url="https://example.com" /> here.')).toBe('See more here.')
    expect(toSpeakable('The AI Act passed【2†title】 today [1].')).toBe('The AI Act passed today.')
  })

  test('drops a dangling partial widget tag from mid-stream chunking', () => {
    expect(toSpeakable('Here you go <widget:weather-fo')).toBe('Here you go')
  })

  test('turns display math into a pointer and removes inline LaTeX', () => {
    expect(toSpeakable('The result is $$E = mc^2$$ exactly.')).toBe(
      'The result is See the equation on screen. exactly.',
    )
    expect(toSpeakable('We know that \\[a^2 + b^2 = c^2\\] holds.')).toBe(
      'We know that See the equation on screen. holds.',
    )
    expect(toSpeakable('So $x$ equals the value \\(y\\) we found.')).toBe('So equals the value we found.')
    expect(toSpeakable('Use \\frac{a}{b} for the ratio.')).toBe('Use for the ratio.')
  })

  test('keeps dollar-sign currency amounts (not mistaken for inline math)', () => {
    expect(toSpeakable('it costs $5 and $10 apiece')).toBe('it costs $5 and $10 apiece')
    expect(toSpeakable('the total was $1,234.56 today')).toBe('the total was $1,234.56 today')
  })
})

describe('partsToSpeech', () => {
  test('replaces a quiz/ask widget with an announcement, never its guts', () => {
    const text =
      'Here is a quiz: <widget:ask prompt="What is 5 > 3?" mode="single" ' +
      'options=\'[{"id":"a","text":"True","isCorrect":true},{"id":"b","text":"False"}]\' />'
    const speech = partsToSpeech(parseContentParts(text))
    expect(speech).toBe('Here is a quiz: Please choose one of the options on screen.')
    expect(speech).not.toContain('True')
    expect(speech).not.toContain('isCorrect')
  })

  test('keeps prose and drops reference-only widgets', () => {
    const text = 'This is true. <widget:citation sources=\'[{"id":"1"}]\' /> And more.'
    expect(partsToSpeech(parseContentParts(text))).toBe('This is true. And more.')
  })

  test('announces a weather widget between prose', () => {
    const text = 'Weather: <widget:weather-forecast location="Seattle" region="WA" country="USA" /> Enjoy!'
    expect(partsToSpeech(parseContentParts(text))).toBe(
      'Weather: Take a look at the weather forecast on screen. Enjoy!',
    )
  })
})
