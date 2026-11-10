/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  isInScope,
  isoWeek,
  parseDocsOverride,
  parseLog,
  relevantChanges,
  rotationSlice,
  rotationWeeks,
} from './docs-audit-select'

describe('isInScope', () => {
  test('accepts docs Markdown and every AGENTS.md', () => {
    expect(isInScope('docs/faq.md')).toBe(true)
    expect(isInScope('docs/internals/architecture/e2e-encryption.md')).toBe(true)
    expect(isInScope('AGENTS.md')).toBe(true)
    expect(isInScope('miniapps/samples/finance/AGENTS.md')).toBe(true)
  })

  test('rejects other files', () => {
    expect(isInScope('docs/screenshots/main.png')).toBe(false)
    expect(isInScope('README.md')).toBe(false)
    expect(isInScope('web/src/content/docs/index.md')).toBe(false)
    expect(isInScope('NOTAGENTS.md')).toBe(false)
    expect(isInScope('CLAUDE.md')).toBe(false)
  })
})

describe('isoWeek', () => {
  test('matches ISO 8601 at year boundaries', () => {
    expect(isoWeek(new Date('2026-01-01T12:00:00Z'))).toBe(1)
    expect(isoWeek(new Date('2027-01-01T12:00:00Z'))).toBe(53)
    expect(isoWeek(new Date('2024-12-30T12:00:00Z'))).toBe(1)
    expect(isoWeek(new Date('2026-11-09T07:00:00Z'))).toBe(46)
  })
})

describe('rotationSlice', () => {
  const files = Array.from({ length: 10 }, (_, index) => `docs/${String(index).padStart(2, '0')}.md`)

  test('covers every file exactly once across the rotation', () => {
    const slices = Array.from({ length: rotationWeeks }, (_, week) => rotationSlice(files, week))
    expect(slices.flat().sort()).toEqual(files)
  })

  test('ignores input order and wraps the week', () => {
    expect(rotationSlice([...files].reverse(), 5)).toEqual(rotationSlice(files, 1))
  })
})

describe('parseLog', () => {
  test('reads commits, statuses and renames', () => {
    const log = [
      '\x1eabc1234\x1ffeat: add a thing\n\nM\tsrc/a.ts\nR087\tdocs/old.md\tdocs/new.md\n',
      '\x1edef5678\x1ffix: empty commit\n',
    ].join('')
    expect(parseLog(log)).toEqual([
      {
        sha: 'abc1234',
        subject: 'feat: add a thing',
        files: [
          { status: 'M', path: 'src/a.ts' },
          { status: 'R', path: 'docs/new.md', previous: 'docs/old.md' },
        ],
      },
      { sha: 'def5678', subject: 'fix: empty commit', files: [] },
    ])
  })
})

describe('relevantChanges', () => {
  test('drops docs, lockfiles, catalogs and generated wasm, then empty commits', () => {
    const commits = [
      {
        sha: 'a',
        subject: 'feat: mixed',
        files: [
          { status: 'M', path: 'backend/src/config/settings.ts' },
          { status: 'M', path: 'bun.lock' },
          { status: 'M', path: 'docs/faq.md' },
        ],
      },
      {
        sha: 'b',
        subject: 'chore: noise only',
        files: [
          { status: 'M', path: 'src/locales/de/messages.po' },
          { status: 'M', path: 'backend/src/emails/locales/de/messages.ts' },
          { status: 'M', path: 'src/acp/iroh/pkg/client_bg.wasm' },
          { status: 'M', path: 'AGENTS.md' },
        ],
      },
    ]
    expect(relevantChanges(commits)).toEqual([
      { sha: 'a', subject: 'feat: mixed', files: [{ status: 'M', path: 'backend/src/config/settings.ts' }] },
    ])
  })
})

describe('parseDocsOverride', () => {
  const scope = ['AGENTS.md', 'docs/faq.md']

  test('splits and trims the list', () => {
    expect(parseDocsOverride(' docs/faq.md, AGENTS.md ,', scope)).toEqual(['docs/faq.md', 'AGENTS.md'])
  })

  test('rejects a file outside the scope', () => {
    expect(() => parseDocsOverride('docs/faq.md,src/app.tsx', scope)).toThrow('src/app.tsx')
  })
})
