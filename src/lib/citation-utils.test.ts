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

  describe('security validation', () => {
    it('rejects javascript: URLs', () => {
      const sources = [{ id: '1', title: 'XSS', url: 'javascript:alert(1)' }]
      expect(decodeCitationSources(JSON.stringify(sources))).toBeNull()
    })

    it('rejects data: URLs', () => {
      const sources = [{ id: '1', title: 'XSS', url: 'data:text/html,<script>alert(1)</script>' }]
      expect(decodeCitationSources(JSON.stringify(sources))).toBeNull()
    })

    it('rejects file: URLs', () => {
      const sources = [{ id: '1', title: 'File Access', url: 'file:///etc/passwd' }]
      expect(decodeCitationSources(JSON.stringify(sources))).toBeNull()
    })

    it('rejects malformed URLs', () => {
      const sources = [{ id: '1', title: 'Bad URL', url: 'not a url' }]
      expect(decodeCitationSources(JSON.stringify(sources))).toBeNull()
    })

    it('rejects missing required id field', () => {
      const sources = [{ title: 'Test', url: 'https://example.com' }]
      expect(decodeCitationSources(JSON.stringify(sources))).toBeNull()
    })

    it('rejects missing required title field', () => {
      const sources = [{ id: '1', url: 'https://example.com' }]
      expect(decodeCitationSources(JSON.stringify(sources))).toBeNull()
    })

    it('rejects missing required url field', () => {
      const sources = [{ id: '1', title: 'Test' }]
      expect(decodeCitationSources(JSON.stringify(sources))).toBeNull()
    })

    it('rejects empty id string', () => {
      const sources = [{ id: '', title: 'Test', url: 'https://example.com' }]
      expect(decodeCitationSources(JSON.stringify(sources))).toBeNull()
    })

    it('rejects empty title string', () => {
      const sources = [{ id: '1', title: '', url: 'https://example.com' }]
      expect(decodeCitationSources(JSON.stringify(sources))).toBeNull()
    })

    it('rejects javascript: in favicon URL', () => {
      const sources = [
        {
          id: '1',
          title: 'Test',
          url: 'https://example.com',
          favicon: 'javascript:alert(1)',
        },
      ]
      expect(decodeCitationSources(JSON.stringify(sources))).toBeNull()
    })

    it('rejects all-or-nothing validation: partial invalid sources', () => {
      const sources = [
        { id: '1', title: 'Valid', url: 'https://example.com' },
        { id: '2', title: 'Invalid', url: 'javascript:alert(1)' },
      ]
      expect(decodeCitationSources(JSON.stringify(sources))).toBeNull()
    })

    it('accepts valid https URLs', () => {
      const sources = [{ id: '1', title: 'Test', url: 'https://example.com' }]
      expect(decodeCitationSources(JSON.stringify(sources))).toEqual(sources)
    })

    it('accepts valid http URLs', () => {
      const sources = [{ id: '1', title: 'Test', url: 'http://example.com' }]
      expect(decodeCitationSources(JSON.stringify(sources))).toEqual(sources)
    })

    it('accepts optional fields with valid values', () => {
      const sources = [
        {
          id: '1',
          title: 'Test',
          url: 'https://example.com',
          siteName: 'Example',
          favicon: 'https://example.com/favicon.ico',
          isPrimary: true,
        },
      ]
      expect(decodeCitationSources(JSON.stringify(sources))).toEqual(sources)
    })

    it('accepts missing optional fields', () => {
      const sources = [{ id: '1', title: 'Test', url: 'https://example.com' }]
      expect(decodeCitationSources(JSON.stringify(sources))).toEqual(sources)
    })
  })
})
