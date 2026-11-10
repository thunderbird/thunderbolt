/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  diffPaths,
  isInScope,
  parseDocsOverride,
  parseLog,
  relevantChanges,
  rotationSlice,
  rotationWeeks,
  weekIndex,
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

describe('weekIndex', () => {
  const mondays = ['2026-12-21', '2026-12-28', '2027-01-04', '2027-01-11'].map((day) => new Date(`${day}T06:00:00Z`))

  test('counts consecutive weeks across a year boundary', () => {
    const [first, ...rest] = mondays.map(weekIndex)
    expect(rest).toEqual([first + 1, first + 2, first + 3])
  })

  test('keeps Monday through Sunday in one week', () => {
    expect(weekIndex(new Date('2026-12-28T00:00:00Z'))).toBe(weekIndex(new Date('2027-01-03T23:59:59Z')))
    expect(weekIndex(new Date('2027-01-04T00:00:00Z'))).toBe(weekIndex(new Date('2027-01-03T23:59:59Z')) + 1)
  })

  test('reviews every doc once over the weeks around new year', () => {
    const files = Array.from({ length: 9 }, (_, index) => `docs/${index}.md`)
    expect(mondays.flatMap((monday) => rotationSlice(files, weekIndex(monday))).sort()).toEqual(files.sort())
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
          { status: 'A', path: 'backend/drizzle/meta/0042_snapshot.json' },
          { status: 'M', path: 'AGENTS.md' },
        ],
      },
    ]
    expect(relevantChanges(commits)).toEqual([
      { sha: 'a', subject: 'feat: mixed', files: [{ status: 'M', path: 'backend/src/config/settings.ts' }] },
    ])
  })
})

describe('diffPaths', () => {
  test('covers both sides of a rename', () => {
    const commit = {
      sha: 'a',
      subject: 'refactor: move settings',
      files: [
        { status: 'M', path: 'src/app.tsx' },
        { status: 'R', path: 'backend/src/config/env.ts', previous: 'backend/src/config/settings.ts' },
      ],
    }
    expect(diffPaths(commit)).toEqual(['src/app.tsx', 'backend/src/config/settings.ts', 'backend/src/config/env.ts'])
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
