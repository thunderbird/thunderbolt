import { describe, expect, it } from 'bun:test'
import { decodeCitationSources } from './citation-utils'

describe('decodeCitationSources', () => {
  const validSources = [{ id: '1', title: 'Test', url: 'https://example.com', siteName: 'Example' }]

  describe('raw JSON parsing', () => {
    it('parses raw JSON array', () => {
      const json = JSON.stringify(validSources)
      const result = decodeCitationSources(json)

      expect(result).toEqual(validSources)
    })

    it('parses raw JSON with whitespace', () => {
      const json = `  ${JSON.stringify(validSources)}  `
      const result = decodeCitationSources(json)

      expect(result).toEqual(validSources)
    })

    it('parses multiple sources', () => {
      const sources = [
        { id: '1', title: 'First', url: 'https://a.com', isPrimary: true },
        { id: '2', title: 'Second', url: 'https://b.com' },
      ]
      const result = decodeCitationSources(JSON.stringify(sources))

      expect(result).toEqual(sources)
    })

    it('returns null for empty JSON array', () => {
      const result = decodeCitationSources('[]')

      expect(result).toBeNull()
    })

    it('returns null for non-array JSON', () => {
      const result = decodeCitationSources('{"id":"1"}')

      expect(result).toBeNull()
    })

    it('returns null for malformed JSON', () => {
      const result = decodeCitationSources('[{"id":"1"')

      expect(result).toBeNull()
    })
  })

  describe('base64 fallback', () => {
    it('decodes valid base64-encoded JSON', () => {
      const json = JSON.stringify(validSources)
      const base64 = btoa(json)
      const result = decodeCitationSources(base64)

      expect(result).toEqual(validSources)
    })

    it('returns null for invalid base64', () => {
      const result = decodeCitationSources('not-valid-base64!!!')

      expect(result).toBeNull()
    })

    it('returns null for base64 with invalid JSON', () => {
      const base64 = btoa('not json')
      const result = decodeCitationSources(base64)

      expect(result).toBeNull()
    })
  })

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(decodeCitationSources('')).toBeNull()
    })

    it('prefers raw JSON when string starts with [', () => {
      const json = JSON.stringify(validSources)
      const result = decodeCitationSources(json)

      expect(result).toEqual(validSources)
    })
  })
})
