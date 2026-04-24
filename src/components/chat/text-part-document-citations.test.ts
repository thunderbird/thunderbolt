import { describe, expect, it } from 'bun:test'
import { buildDocumentCitationPlaceholders } from './text-part'
import type { DocumentReference } from '@/types'
import type { DocumentCitationSource } from '@/types/citation'

describe('buildDocumentCitationPlaceholders', () => {
  const refs: DocumentReference[] = [
    { position: 1, fileId: 'f1', fileName: 'report.pdf', pageNumber: 3 },
    { position: 2, fileId: 'f2', fileName: 'notes.docx' },
  ]

  it('replaces [N] patterns with {{CITE:N}} placeholders', () => {
    const { fullText, citations } = buildDocumentCitationPlaceholders('See [1] and [2] for details.', refs)

    expect(fullText).toBe('See {{CITE:0}} and {{CITE:1}} for details.')
    expect(citations.size).toBe(2)
  })

  it('creates document citation sources with correct metadata', () => {
    const { citations } = buildDocumentCitationPlaceholders('See [1].', refs)

    const sources = citations.get(0)!
    expect(sources).toHaveLength(1)
    expect(sources[0].title).toBe('report.pdf')
    expect(sources[0].siteName).toBe('PDF')
    const docSource = sources[0] as unknown as DocumentCitationSource
    expect(docSource.documentMeta.fileId).toBe('f1')
    expect(docSource.documentMeta.pageNumber).toBe(3)
  })

  it('leaves out-of-range references as-is', () => {
    const { fullText, citations } = buildDocumentCitationPlaceholders('See [3] and [1].', refs)

    // [3] is out of range (no position 3), [1] is valid
    expect(fullText).toContain('[3]')
    expect(fullText).toContain('{{CITE:0}}')
    expect(citations.size).toBe(1)
  })

  it('groups adjacent citations', () => {
    const { fullText, citations } = buildDocumentCitationPlaceholders('See [1] [2].', refs)

    expect(fullText).toBe('See {{CITE:0}}.')
    expect(citations.size).toBe(1)
    expect(citations.get(0)!).toHaveLength(2)
  })

  it('does not match markdown links', () => {
    const { fullText, citations } = buildDocumentCitationPlaceholders('[click here](https://example.com)', refs)

    expect(fullText).toBe('[click here](https://example.com)')
    expect(citations.size).toBe(0)
  })

  it('handles empty references', () => {
    const { fullText, citations } = buildDocumentCitationPlaceholders('No refs here.', [])

    expect(fullText).toBe('No refs here.')
    expect(citations.size).toBe(0)
  })

  it('uses startKey for offset', () => {
    const { citations } = buildDocumentCitationPlaceholders('See [1].', refs, 5)

    expect(citations.has(5)).toBe(true)
    expect(citations.has(0)).toBe(false)
  })
})
