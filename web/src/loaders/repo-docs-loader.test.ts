/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, mock, test } from 'bun:test'
import type { LoaderContext } from 'astro/loaders'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  repoDocsLoader,
  computeSlug,
  extractDescription,
  fallbackTitle,
  parseFrontmatter,
  resolveRepoPath,
  rewriteLinks,
  walkMarkdown,
} from './repo-docs-loader'

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  test('returns empty data and full content when no frontmatter', () => {
    const raw = '# Title\n\nSome content.'
    const { data, content } = parseFrontmatter(raw)
    expect(data).toEqual({})
    expect(content).toBe(raw)
  })

  test('parses simple key-value pairs', () => {
    const raw = '---\ntitle: My Doc\ndescription: A description\n---\n\nBody.'
    const { data, content } = parseFrontmatter(raw)
    expect(data.title).toBe('My Doc')
    expect(data.description).toBe('A description')
    expect(content).toBe('\nBody.')
  })

  test('strips surrounding quotes from values', () => {
    const raw = `---\ntitle: "Quoted Title"\nauthor: 'Single Quoted'\n---\n`
    const { data } = parseFrontmatter(raw)
    expect(data.title).toBe('Quoted Title')
    expect(data.author).toBe('Single Quoted')
  })

  test('handles dashed keys (e.g. sidebar-label)', () => {
    const raw = '---\nsidebar-label: Short Name\n---\n'
    const { data } = parseFrontmatter(raw)
    expect(data['sidebar-label']).toBe('Short Name')
  })

  test('parses array-syntax values as a raw string (current limitation)', () => {
    const raw = '---\ntags: [foo, bar]\n---\n'
    const { data } = parseFrontmatter(raw)
    // The parser doesn't interpret YAML arrays — it returns the raw string.
    // This test documents that behavior so breakage is caught if it changes.
    expect(data.tags).toBe('[foo, bar]')
  })
})

// ---------------------------------------------------------------------------
// computeSlug
// ---------------------------------------------------------------------------

describe('computeSlug', () => {
  test('simple top-level file', () => {
    expect(computeSlug('architecture.md', 'docs')).toBe('docs/architecture')
  })

  test('nested file', () => {
    expect(computeSlug('architecture/e2e-encryption.md', 'docs')).toBe('docs/architecture/e2e-encryption')
  })

  test('README.md strips to parent', () => {
    expect(computeSlug('architecture/README.md', 'docs')).toBe('docs/architecture')
  })

  test('index.md strips to parent', () => {
    expect(computeSlug('self-hosting/index.md', 'docs')).toBe('docs/self-hosting')
  })

  test('top-level README.md returns just the prefix', () => {
    expect(computeSlug('README.md', 'docs')).toBe('docs')
  })

  test('normalises to lowercase', () => {
    expect(computeSlug('Architecture/Overview.md', 'docs')).toBe('docs/architecture/overview')
  })

  test('custom prefix', () => {
    expect(computeSlug('guide.md', 'guides')).toBe('guides/guide')
  })
})

// ---------------------------------------------------------------------------
// extractDescription
// ---------------------------------------------------------------------------

describe('extractDescription', () => {
  test('returns first prose paragraph', () => {
    const body = 'This is the first paragraph.\n\nSecond paragraph.'
    expect(extractDescription(body)).toBe('This is the first paragraph.')
  })

  test('skips headings and returns prose below', () => {
    const body = '## Section\n\nThis is the prose paragraph that comes after the heading.'
    expect(extractDescription(body)).toBe('This is the prose paragraph that comes after the heading.')
  })

  test('skips blockquotes', () => {
    const body = '> A note.\n\nActual prose paragraph.'
    expect(extractDescription(body)).toBe('Actual prose paragraph.')
  })

  test('skips list items', () => {
    const body = '- item one\n- item two\n\nProse below the list.'
    expect(extractDescription(body)).toBe('Prose below the list.')
  })

  test('skips fenced code blocks', () => {
    const body = '```bash\necho hello\n```\n\nThis is the real description paragraph below the code block.'
    expect(extractDescription(body)).toBe('This is the real description paragraph below the code block.')
  })

  test('collapses markdown links to link text', () => {
    const body = 'See [the docs](https://example.com) for details on this feature.'
    const desc = extractDescription(body)
    expect(desc).not.toContain('(https://example.com)')
    expect(desc).toContain('the docs')
  })

  test('truncates long paragraphs with ellipsis', () => {
    const long = 'A'.repeat(250)
    const desc = extractDescription(long)
    // slice(0, 197) + '…' = 198 characters total
    expect(desc).toHaveLength(198)
    expect(desc?.endsWith('…')).toBe(true)
  })

  test('returns undefined when no suitable paragraph found', () => {
    const body = '## Only a heading\n\n- list item'
    expect(extractDescription(body)).toBeUndefined()
  })

  test('ignores paragraphs shorter than 20 characters', () => {
    const body = 'Too short.\n\nThis one is long enough to be used as a description.'
    expect(extractDescription(body)).toBe('This one is long enough to be used as a description.')
  })
})

// ---------------------------------------------------------------------------
// fallbackTitle
// ---------------------------------------------------------------------------

describe('fallbackTitle', () => {
  test('converts kebab-case filename to title case', () => {
    expect(fallbackTitle('e2e-encryption.md')).toBe('E2e Encryption')
  })

  test('uses last path segment', () => {
    expect(fallbackTitle('architecture/quick-start.md')).toBe('Quick Start')
  })

  test('converts underscores to spaces', () => {
    expect(fallbackTitle('my_doc.md')).toBe('My Doc')
  })
})

// ---------------------------------------------------------------------------
// resolveRepoPath
// ---------------------------------------------------------------------------

describe('resolveRepoPath', () => {
  test('same-directory link', () => {
    expect(resolveRepoPath('docs/architecture/e2e.md', './powersync.md')).toBe('docs/architecture/powersync.md')
  })

  test('implicit same-directory (no leading ./)', () => {
    expect(resolveRepoPath('docs/architecture/e2e.md', 'powersync.md')).toBe('docs/architecture/powersync.md')
  })

  test('up one level into sibling directory', () => {
    expect(resolveRepoPath('docs/architecture/e2e.md', '../development/quick-start.md')).toBe(
      'docs/development/quick-start.md',
    )
  })

  test('up one level stays in docs root', () => {
    expect(resolveRepoPath('docs/architecture/e2e.md', '../README.md')).toBe('docs/README.md')
  })

  test('escapes docs into repo root', () => {
    // Two levels up from docs/architecture/ exits docs entirely
    expect(resolveRepoPath('docs/architecture/e2e.md', '../../README.md')).toBe('README.md')
  })

  test('escapes docs to a source file (the root cause of the bug)', () => {
    // ../src/... from docs/architecture/ → docs/src/... (one level up lands at docs root)
    expect(resolveRepoPath('docs/architecture/e2e.md', '../src/db/encryption/config.ts')).toBe(
      'docs/src/db/encryption/config.ts',
    )
  })
})

// ---------------------------------------------------------------------------
// rewriteLinks
// ---------------------------------------------------------------------------

const GITHUB = 'https://github.com/thunderbird/thunderbolt/blob/main'

const makeKnown = (...paths: string[]) => new Set(paths)

describe('rewriteLinks', () => {
  test('absolute URLs are left untouched', () => {
    const body = '[Docs](https://example.com)'
    expect(rewriteLinks(body, 'architecture/e2e.md', 'docs', GITHUB, makeKnown())).toBe(body)
  })

  test('fragment-only links are left untouched', () => {
    const body = '[Section](#my-section)'
    expect(rewriteLinks(body, 'architecture/e2e.md', 'docs', GITHUB, makeKnown())).toBe(body)
  })

  test('absolute-path links are left untouched', () => {
    const body = '[Home](/home)'
    expect(rewriteLinks(body, 'architecture/e2e.md', 'docs', GITHUB, makeKnown())).toBe(body)
  })

  test('same-directory .md link to known doc → Starlight URL', () => {
    const known = makeKnown('architecture/powersync-account-devices.md')
    const body = '[PowerSync](./powersync-account-devices.md)'
    expect(rewriteLinks(body, 'architecture/e2e.md', 'docs', GITHUB, known)).toBe(
      '[PowerSync](/docs/architecture/powersync-account-devices)',
    )
  })

  test('link without extension to known doc → Starlight URL', () => {
    const known = makeKnown('architecture/powersync-account-devices.md')
    const body = '[PowerSync](./powersync-account-devices)'
    expect(rewriteLinks(body, 'architecture/e2e.md', 'docs', GITHUB, known)).toBe(
      '[PowerSync](/docs/architecture/powersync-account-devices)',
    )
  })

  test('known doc link preserves fragment', () => {
    const known = makeKnown('architecture/powersync-account-devices.md')
    const body = '[PR flow](./powersync-account-devices.md#pr-flow-for-adding-tables)'
    expect(rewriteLinks(body, 'architecture/e2e.md', 'docs', GITHUB, known)).toBe(
      '[PR flow](/docs/architecture/powersync-account-devices#pr-flow-for-adding-tables)',
    )
  })

  test('README.md link → parent slug', () => {
    const known = makeKnown('README.md')
    const body = '[Docs home](../README.md)'
    expect(rewriteLinks(body, 'architecture/e2e.md', 'docs', GITHUB, known)).toBe('[Docs home](/docs)')
  })

  test('../src/file.ts (escaping docs) → GitHub URL — the fixed bug', () => {
    // docs/src/db/encryption/config.ts is NOT in knownDocPaths, so it must
    // fall through to a GitHub source link rather than a broken docs URL.
    const known = makeKnown('architecture/e2e-encryption.md')
    const body = '[config.ts](../src/db/encryption/config.ts)'
    expect(rewriteLinks(body, 'architecture/e2e-encryption.md', 'docs', GITHUB, known)).toBe(
      `[config.ts](${GITHUB}/docs/src/db/encryption/config.ts)`,
    )
  })

  test('link that truly escapes docs (two levels up) → GitHub URL', () => {
    const known = makeKnown('architecture/e2e-encryption.md')
    const body = '[Root readme](../../README.md)'
    expect(rewriteLinks(body, 'architecture/e2e-encryption.md', 'docs', GITHUB, known)).toBe(
      `[Root readme](${GITHUB}/README.md)`,
    )
  })

  test('link to unknown path within apparent docs tree → GitHub URL', () => {
    // Even if the path resolves to docs/something, if it's not in knownDocPaths
    // it gets a GitHub link (avoids dead Starlight routes).
    const known = makeKnown('architecture/e2e-encryption.md')
    const body = '[Ghost](./nonexistent.md)'
    expect(rewriteLinks(body, 'architecture/e2e-encryption.md', 'docs', GITHUB, known)).toBe(
      `[Ghost](${GITHUB}/docs/architecture/nonexistent.md)`,
    )
  })
})

// ---------------------------------------------------------------------------
// walkMarkdown
// ---------------------------------------------------------------------------

describe('walkMarkdown', () => {
  test('skips internals/ only at the docs root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-docs-'))
    try {
      await mkdir(join(root, 'internals'))
      await mkdir(join(root, 'using', 'internals'), { recursive: true })
      await writeFile(join(root, 'internals', 'hidden.md'), '# Hidden')
      await writeFile(join(root, 'using', 'internals', 'nested.md'), '# Nested')
      await writeFile(join(root, 'using', 'page.md'), '# Page')

      const files = (await walkMarkdown(root)).map((file) => relative(root, file))

      expect(files).toEqual([join('using', 'internals', 'nested.md'), join('using', 'page.md')])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// Real filesystem fixtures exercise the loader boundary, including failures before publication.

type StoredEntry = Parameters<LoaderContext['store']['set']>[0]

/** Capture what Astro receives without coupling fixtures to Astro's on-disk cache. */
const makeLoaderContext = (root: string) => {
  const entries = new Map<string, StoredEntry>([['old', { id: 'old', data: {} }]])
  const clear = mock(() => entries.clear())
  const renderMarkdown = mock<LoaderContext['renderMarkdown']>(async (body) => ({ html: `<article>${body}</article>` }))
  const parseData: LoaderContext['parseData'] = async ({ data }) => data
  const context = {
    config: { root: pathToFileURL(`${root}/web/`) },
    store: {
      clear,
      set: (entry: StoredEntry) => {
        entries.set(entry.id, entry)
        return true
      },
    },
    parseData,
    renderMarkdown,
    generateDigest: (raw: string) => `digest:${raw}`,
  } as unknown as LoaderContext
  return { entries, clear, context, renderMarkdown }
}

/** Create isolated repository content, including a path character that must be URL-encoded. */
const withRepository = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'docs # fixture-'))
  try {
    await mkdir(join(root, 'docs'))
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('repoDocsLoader', () => {
  test('publishes metadata, rendered bodies, digests, and canonical links without duplicate headings', async () => {
    await withRepository(async (root) => {
      await mkdir(join(root, 'docs', 'internals'))
      await writeFile(join(root, 'docs', 'internals', 'private.md'), '# Contributor notes')
      await writeFile(join(root, 'docs', 'README.md'), '# Docs\n\nStart here to learn more about Thunderbolt.')
      const raw =
        '---\r\ntitle: Custom title\r\ndescription: Explicit description\r\n---\r\n\r\n# Original title\r\n\r\n[Home](./README.md) and [Source](internals/private.md).'
      await writeFile(join(root, 'docs', 'guide.md'), raw)
      await writeFile(join(root, 'docs', 'no-title.md'), 'Short.')
      const { context, entries, renderMarkdown } = makeLoaderContext(root)
      await repoDocsLoader({ base: '../docs' }).load(context)
      expect([...entries.keys()].sort()).toEqual(['docs', 'docs/guide', 'docs/no-title'])
      expect(entries.get('docs')!.data.title).toBe('Docs')
      expect(entries.get('docs')!.data.description).toBe('Start here to learn more about Thunderbolt.')
      expect(entries.get('docs/no-title')!.data).toEqual({ title: 'No Title', description: '' })
      expect(entries.get('docs/guide')).toMatchObject({
        data: { title: 'Custom title', description: 'Explicit description' },
        filePath: '../docs/guide.md',
        digest: `digest:${raw}`,
        body: `[Home](/docs) and [Source](${GITHUB}/docs/internals/private.md).`,
      })
      expect(entries.get('docs/guide')!.rendered!.html).toContain('<article>[Home](/docs)')
      const renderOptions = renderMarkdown.mock.calls.find(([body]) => body.startsWith('[Home]'))![1]!
      expect(fileURLToPath(renderOptions.fileURL!)).toBe(join(root, 'docs', 'guide.md'))
    })
  })

  test('supports a trailing base slash, custom routes, and custom repository destinations', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'docs', 'README.md'), '# Only title')
      await writeFile(join(root, 'docs', 'guide.md'), '[Home](README.md) [Source](../src/index.ts)')
      const { context, entries } = makeLoaderContext(root)
      await repoDocsLoader({ base: '../docs/', urlPrefix: 'help', githubBaseUrl: 'https://example.org/source' }).load(
        context,
      )
      expect(entries.get('help')!.body).toBe('')
      expect(entries.get('help/guide')!.body).toBe('[Home](/help) [Source](https://example.org/source/src/index.ts)')
    })
  })

  test.each(['schema', 'render'] as const)('preserves the previous collection when %s fails', async (failure) => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n\nA useful guide to Thunderbolt.')
      const { context, entries, clear } = makeLoaderContext(root)
      const error = new Error(`Invalid ${failure}`)
      if (failure === 'schema')
        context.parseData = async () => {
          throw error
        }
      else
        context.renderMarkdown = async () => {
          throw error
        }
      await expect(repoDocsLoader({ base: '../docs' }).load(context)).rejects.toBe(error)
      expect(clear).not.toHaveBeenCalled()
      expect([...entries.keys()]).toEqual(['old'])
    })
  })

  test('fails loudly on a missing source directory without wiping the last successful collection', async () => {
    await withRepository(async (root) => {
      const { context, entries } = makeLoaderContext(root)
      await expect(repoDocsLoader({ base: '../missing' }).load(context)).rejects.toMatchObject({ code: 'ENOENT' })
      expect([...entries.keys()]).toEqual(['old'])
    })
  })
})

test('frontmatter handles Windows newlines, blank/comment lines, and closing delimiter at EOF', () => {
  expect(parseFrontmatter('---\r\n# Comment\r\n\r\ntitle: Title\r\n---')).toEqual({
    data: { title: 'Title' },
    content: '',
  })
})

test('relative paths normalize interior dot segments and cannot escape the repository root', () => {
  expect(resolveRepoPath('docs/using.md', 'self-hosting/../README.md')).toBe('docs/README.md')
  expect(resolveRepoPath('docs/using.md', '../../../README.md')).toBe('README.md')
  expect(rewriteLinks('[Home](nested/../README.md)', 'guide.md', 'docs', GITHUB, makeKnown('README.md'))).toBe(
    '[Home](/docs)',
  )
})

test.each(['//example.org/docs', 'mailto:hello@example.org', 'tel:+123456789', 'vscode://file/path'])(
  'leaves external destinations unchanged: %s',
  (url) => {
    const body = `[Link](${url})`
    expect(rewriteLinks(body, 'guide.md', 'docs', GITHUB, makeKnown())).toBe(body)
  },
)

test('description ignores HTML, tables, and empty blocks, and removes inline formatting', () => {
  expect(
    extractDescription(
      '\n\n<div>A custom component</div>\n\n| Column | Value |\n\nThis **paragraph** has _emphasis_ and `code`.',
    ),
  ).toBe('This paragraph has emphasis and code.')
})

test('walkMarkdown ignores hidden files, directories, non-Markdown files, and symbolic links', async () => {
  await withRepository(async (root) => {
    const dir = join(root, 'docs')
    await mkdir(join(dir, '_drafts'))
    await mkdir(join(dir, '.private'))
    await Promise.all([
      writeFile(join(dir, '_drafts', 'draft.md'), '# Draft'),
      writeFile(join(dir, '.private', 'hidden.md'), '# Hidden'),
      writeFile(join(dir, '_draft.md'), '# Draft'),
      writeFile(join(dir, '.hidden.md'), '# Hidden'),
      writeFile(join(dir, 'image.svg'), '<svg/>'),
      writeFile(join(dir, 'Z.MD'), '# Published'),
      writeFile(join(dir, 'a.md'), '# Published'),
    ])
    await symlink(join(dir, 'a.md'), join(dir, 'linked.md'))
    expect((await walkMarkdown(dir)).map((path) => relative(dir, path))).toEqual(['Z.MD', 'a.md'])
  })
})
