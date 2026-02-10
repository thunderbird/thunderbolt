import { describe, expect, test } from 'bun:test'
import type { SourceMetadata } from '@/types/source'
import { buildSourceCitationPlaceholders } from './text-part'

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

  test('replaces multiple adjacent citations [1][2]', () => {
    const { fullText, citations } = buildSourceCitationPlaceholders('Studies show [1][2] this.', sources)

    expect(fullText).toBe('Studies show {{CITE:0}}{{CITE:1}} this.')
    expect(citations.size).toBe(2)
    expect(citations.get(0)?.[0].id).toBe('1')
    expect(citations.get(1)?.[0].id).toBe('2')
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
})
