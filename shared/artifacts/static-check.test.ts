/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests the shared checker in isolation, with stand-in parsers instead of acorn
 * and css-tree: that pins the seam each harness plugs its own libraries into, and
 * keeps this file free of dependencies (nothing resolves above `shared/`).
 * Behaviour with the real parsers is covered where they are wired up —
 * `cloud-runner/src/artifact-validation.test.ts`.
 */

import { describe, expect, it } from 'bun:test'
import {
  checkInlineBlocks,
  formatStaticIssue,
  isJsScriptType,
  isModuleScriptType,
  type CssParser,
  type InlineBlocks,
  type JsParser,
} from './static-check.ts'

const noBlocks: InlineBlocks = { scripts: [], styles: [], externalResources: [] }

/** Parses nothing; records the source types it was asked for. */
const spyJs = (): JsParser & { calls: string[] } => {
  const calls: string[] = []
  return Object.assign(
    (_code: string, options: { sourceType: 'script' | 'module' }) => {
      calls.push(options.sourceType)
      return {}
    },
    { calls },
  )
}

const throwingJs: JsParser = () => {
  throw Object.assign(new SyntaxError('Unexpected token'), { loc: { line: 4, column: 9 } })
}

const cleanCss: CssParser = () => ({})

const reportingCss: CssParser = (_css, { onParseError }) => {
  onParseError({ rawMessage: 'Colon is expected', message: 'noisy wrapper', line: 2, column: 7 })
  return {}
}

describe('script type predicates', () => {
  it('treats an absent, empty, or JS-ish type as JavaScript', () => {
    for (const type of [undefined, null, '', ' ', 'module', 'TEXT/JavaScript', 'text/ecmascript']) {
      expect(isJsScriptType(type)).toBe(true)
    }
  })

  it('rejects data islands and templates', () => {
    for (const type of ['importmap', 'application/json', 'text/template', 'speculationrules']) {
      expect(isJsScriptType(type)).toBe(false)
    }
  })

  it('recognizes module scripts regardless of case or padding', () => {
    expect(isModuleScriptType(' Module ')).toBe(true)
    expect(isModuleScriptType('text/javascript')).toBe(false)
  })
})

describe('checkInlineBlocks', () => {
  it('reports nothing for a document with no inline blocks or references', () => {
    expect(checkInlineBlocks(noBlocks, spyJs(), cleanCss)).toEqual([])
  })

  it('parses classic and module scripts under their own source type', () => {
    const parseJs = spyJs()
    checkInlineBlocks(
      {
        ...noBlocks,
        scripts: [
          { code: 'a', module: false },
          { code: 'b', module: true },
        ],
      },
      parseJs,
      cleanCss,
    )
    expect(parseJs.calls).toEqual(['script', 'module'])
  })

  it('turns a thrown parse error into a js issue with its position', () => {
    expect(checkInlineBlocks({ ...noBlocks, scripts: [{ code: 'x', module: false }] }, throwingJs, cleanCss)).toEqual([
      { source: 'js', message: 'Unexpected token', line: 4, column: 9 },
    ])
  })

  it('prefers a css error’s raw message over its decorated one', () => {
    expect(checkInlineBlocks({ ...noBlocks, styles: ['x'] }, spyJs(), reportingCss)).toEqual([
      { source: 'css', message: 'Colon is expected', line: 2, column: 7 },
    ])
  })

  it('names each blocked reference in the markup form it was written', () => {
    const issues = checkInlineBlocks(
      {
        ...noBlocks,
        externalResources: [
          { kind: 'script', url: 'https://cdn.example.com/lib.js' },
          { kind: 'stylesheet', url: '/a.css' },
        ],
      },
      spyJs(),
      cleanCss,
    )
    expect(issues.map((issue) => issue.source)).toEqual(['resource', 'resource'])
    expect(issues[0].message).toContain('<script src="https://cdn.example.com/lib.js">')
    expect(issues[1].message).toContain('<link rel="stylesheet" href="/a.css">')
  })

  it('reports resources, then JS, then CSS, so the list reads consistently', () => {
    const issues = checkInlineBlocks(
      {
        scripts: [{ code: 'x', module: false }],
        styles: ['y'],
        externalResources: [{ kind: 'script', url: '/a.js' }],
      },
      throwingJs,
      reportingCss,
    )
    expect(issues.map((issue) => issue.source)).toEqual(['resource', 'js', 'css'])
  })
})

describe('formatStaticIssue', () => {
  it('passes a resource issue through — it already reads as an instruction', () => {
    expect(formatStaticIssue({ source: 'resource', message: 'Inline it instead.' })).toBe('Inline it instead.')
  })

  it('prefixes a syntax error with its language and position', () => {
    expect(formatStaticIssue({ source: 'js', message: 'Unexpected token', line: 4, column: 9 })).toBe(
      'Invalid JS (line 4:9): Unexpected token',
    )
    expect(formatStaticIssue({ source: 'css', message: 'Colon is expected', line: 2 })).toBe(
      'Invalid CSS (line 2): Colon is expected',
    )
    expect(formatStaticIssue({ source: 'css', message: 'Colon is expected' })).toBe('Invalid CSS: Colon is expected')
  })
})
