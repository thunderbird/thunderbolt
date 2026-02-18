import { describe, expect, test } from 'bun:test'
import type { ContentPart } from '@/ai/widget-parser'
import type { SourceMetadata } from '@/types/source'
import { buildSourceCitationPlaceholders, deduplicateLinkPreviews } from './text-part'

const makeSource = (index: number, title = `Source ${index}`): SourceMetadata => ({
  index,
  url: `https://example.com/${index}`,
  title,
  siteName: 'example.com',
  toolName: 'search',
})

describe('buildSourceCitationPlaceholders', () => {
  const sources: SourceMetadata[] = [makeSource(1), makeSource(2), makeSource(3)]

  test('replaces [1] with a citation placeholder', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('See [1] for details.', sources)

    expect(fullText).toBe('See {{CITE:0}} for details.')
    expect(citations.size).toBe(1)
    expect(citations.get(0)?.[0].id).toBe('1')
    expect(citations.get(0)?.[0].title).toBe('Source 1')
  })

  test('groups adjacent citations [1][2] into a single map entry', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('Studies show [1][2] this.', sources)

    expect(fullText).toBe('Studies show {{CITE:0}} this.')
    expect(citations.size).toBe(1)
    const entry = citations.get(0)!
    expect(entry).toHaveLength(2)
    expect(entry[0].id).toBe('1')
    expect(entry[0].isPrimary).toBe(true)
    expect(entry[1].id).toBe('2')
    expect(entry[1].isPrimary).toBe(false)
  })

  test('replaces [1], [2], and [3] across text', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('First [1], second [2], third [3].', sources)

    expect(fullText).toBe('First {{CITE:0}}, second {{CITE:1}}, third {{CITE:2}}.')
    expect(citations.size).toBe(3)
  })

  test('leaves [N] as-is when N exceeds sources length', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('See [4] and [1].', sources)

    expect(fullText).toBe('See [4] and {{CITE:0}}.')
    expect(citations.size).toBe(1)
  })

  test('leaves [0] as-is (sources are 1-based)', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('See [0].', sources)

    expect(fullText).toBe('See [0].')
    expect(citations.size).toBe(0)
  })

  test('does not match markdown links [text](url)', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('Check [1](https://example.com) for more.', sources)

    expect(fullText).toBe('Check [1](https://example.com) for more.')
    expect(citations.size).toBe(0)
  })

  test('matches [N] but not markdown link when both present', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders(
      'See [1] and [click here](https://example.com).',
      sources,
    )

    expect(fullText).toBe('See {{CITE:0}} and [click here](https://example.com).')
    expect(citations.size).toBe(1)
  })

  test('returns empty citations when text has no [N] patterns', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('No citations here.', sources)

    expect(fullText).toBe('No citations here.')
    expect(citations.size).toBe(0)
  })

  test('returns empty citations when sources array is empty', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('See [1].', [])

    expect(fullText).toBe('See [1].')
    expect(citations.size).toBe(0)
  })

  test('handles multi-digit source indices', () => {
    const manySources = Array.from({ length: 12 }, (_, i) => makeSource(i + 1))
    const { fullText, citations } = buildSourceCitationPlaceholders('See [12].', manySources)

    expect(fullText).toBe('See {{CITE:0}}.')
    expect(citations.size).toBe(1)
    expect(citations.get(0)?.[0].id).toBe('12')
  })

  test('each citation map entry is an array of one source with isPrimary', () => {
    const { citations } = buildSourceCitationPlaceholders('See [1].', sources)

    const entry = citations.get(0)
    expect(entry).toHaveLength(1)
    expect(entry?.[0].isPrimary).toBe(true)
  })

  test('duplicate [N] references create separate map entries', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('First [1] then again [1].', sources)

    expect(fullText).toBe('First {{CITE:0}} then again {{CITE:1}}.')
    expect(citations.size).toBe(2)
    expect(citations.get(0)?.[0].url).toBe(citations.get(1)?.[0].url)
  })

  test('preserves text around citations intact', () => {
    const { fullText } = buildSourceCitationPlaceholders('**Bold** text [1] and `code` [2] here.', sources)

    expect(fullText).toBe('**Bold** text {{CITE:0}} and `code` {{CITE:1}} here.')
  })

  test('groups three adjacent citations with spaces into 1 entry with 3 sources', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('Results [1] [2] [3] are clear.', sources)

    expect(fullText).toBe('Results {{CITE:0}} are clear.')
    expect(citations.size).toBe(1)
    const entry = citations.get(0)!
    expect(entry).toHaveLength(3)
    expect(entry[0].isPrimary).toBe(true)
    expect(entry[1].isPrimary).toBe(false)
    expect(entry[2].isPrimary).toBe(false)
  })

  test('groups adjacent citations without spaces [1][2][3]', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('Results[1][2][3].', sources)

    expect(fullText).toBe('Results{{CITE:0}}.')
    expect(citations.size).toBe(1)
    expect(citations.get(0)).toHaveLength(3)
  })

  test('groups mixed valid/invalid [1][99][2] keeping only valid sources', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('See [1][99][2].', sources)

    expect(fullText).toBe('See {{CITE:0}}.')
    expect(citations.size).toBe(1)
    const entry = citations.get(0)!
    expect(entry).toHaveLength(2)
    expect(entry[0].id).toBe('1')
    expect(entry[0].isPrimary).toBe(true)
    expect(entry[1].id).toBe('2')
    expect(entry[1].isPrimary).toBe(false)
  })

  test('all-invalid adjacent group [98][99] leaves text unchanged', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('See [98][99].', sources)

    expect(fullText).toBe('See [98][99].')
    expect(citations.size).toBe(0)
  })

  test('non-adjacent citations with text between them create separate entries', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('[1] some text [2]', sources)

    expect(fullText).toBe('{{CITE:0}} some text {{CITE:1}}')
    expect(citations.size).toBe(2)
    expect(citations.get(0)).toHaveLength(1)
    expect(citations.get(1)).toHaveLength(1)
  })

  test('adjacent group + separate non-adjacent creates 2 entries', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('First [1][2] then [3].', sources)

    expect(fullText).toBe('First {{CITE:0}} then {{CITE:1}}.')
    expect(citations.size).toBe(2)
    expect(citations.get(0)).toHaveLength(2)
    expect(citations.get(1)).toHaveLength(1)
  })

  test('does not group across markdown links [1][text](url)[2]', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('See [1][text](https://x.com)[2].', sources)

    expect(citations.size).toBe(2)
    expect(citations.get(0)).toHaveLength(1)
    expect(citations.get(1)).toHaveLength(1)
    expect(fullText).toContain('[text](https://x.com)')
  })
})

const makeLinkPreview = (url: string): ContentPart => ({
  type: 'widget',
  widget: { widget: 'link-preview', args: { url } },
})

const makeText = (content: string): ContentPart => ({
  type: 'text',
  content,
})

describe('deduplicateLinkPreviews', () => {
  test('removes duplicate link-preview URLs', () => {
    const parts = [makeLinkPreview('https://apnews.com/'), makeLinkPreview('https://apnews.com/')]
    expect(deduplicateLinkPreviews(parts)).toHaveLength(1)
  })

  test('keeps unique link-preview URLs', () => {
    const parts = [
      makeLinkPreview('https://apnews.com/article/one'),
      makeLinkPreview('https://bbc.com/news/two'),
      makeLinkPreview('https://reuters.com/world/three'),
    ]
    expect(deduplicateLinkPreviews(parts)).toHaveLength(3)
  })

  test('normalizes trailing slashes for dedup', () => {
    const parts = [makeLinkPreview('https://apnews.com'), makeLinkPreview('https://apnews.com/')]
    expect(deduplicateLinkPreviews(parts)).toHaveLength(1)
  })

  test('normalizes host casing for dedup', () => {
    const parts = [makeLinkPreview('https://APNews.com/article/one'), makeLinkPreview('https://apnews.com/article/one')]
    expect(deduplicateLinkPreviews(parts)).toHaveLength(1)
  })

  test('preserves text parts untouched', () => {
    const parts = [makeText('Hello'), makeLinkPreview('https://a.com/'), makeText('World')]
    expect(deduplicateLinkPreviews(parts)).toHaveLength(3)
  })

  test('preserves non-link-preview widgets untouched', () => {
    const weatherWidget: ContentPart = {
      type: 'widget',
      widget: { widget: 'weather-forecast', args: { location: 'Seattle' } } as ContentPart & {
        type: 'widget'
      } extends { widget: infer W }
        ? W
        : never,
    }
    const parts = [weatherWidget, weatherWidget]
    expect(deduplicateLinkPreviews(parts)).toHaveLength(2)
  })

  test('keeps first occurrence when duplicates exist', () => {
    const parts = [
      makeLinkPreview('https://apnews.com/article/first'),
      makeLinkPreview('https://bbc.com/news/second'),
      makeLinkPreview('https://apnews.com/article/first'),
    ]
    const result = deduplicateLinkPreviews(parts)
    expect(result).toHaveLength(2)
    expect((result[0] as { type: 'widget'; widget: { args: { url: string } } }).widget.args.url).toBe(
      'https://apnews.com/article/first',
    )
    expect((result[1] as { type: 'widget'; widget: { args: { url: string } } }).widget.args.url).toBe(
      'https://bbc.com/news/second',
    )
  })

  test('returns empty array for empty input', () => {
    expect(deduplicateLinkPreviews([])).toHaveLength(0)
  })

  test('treats different paths as unique even for same domain', () => {
    const parts = [makeLinkPreview('https://apnews.com/article/one'), makeLinkPreview('https://apnews.com/article/two')]
    expect(deduplicateLinkPreviews(parts)).toHaveLength(2)
  })
})
