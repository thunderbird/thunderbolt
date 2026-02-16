import { describe, expect, it } from 'bun:test'
import { parse, schema } from './schema'

describe('citation widget schema', () => {
  describe('schema validation', () => {
    it('validates valid citation widget with required fields', () => {
      const result = schema.safeParse({
        widget: 'citation',
        args: {
          sources: '[{"id":"1","title":"Test","url":"https://example.com"}]',
        },
      })

      expect(result.success).toBe(true)
    })

    it('rejects widget with wrong name', () => {
      const result = schema.safeParse({
        widget: 'wrong-name',
        args: {
          sources: '[{"id":"1","title":"Test","url":"https://example.com"}]',
        },
      })

      expect(result.success).toBe(false)
    })

    it('rejects widget with missing sources', () => {
      const result = schema.safeParse({
        widget: 'citation',
        args: {},
      })

      expect(result.success).toBe(false)
    })

    it('rejects widget with empty sources string', () => {
      const result = schema.safeParse({
        widget: 'citation',
        args: {
          sources: '',
        },
      })

      expect(result.success).toBe(false)
    })
  })

  describe('parse function', () => {
    it('parses valid attributes correctly', () => {
      const attrs = {
        sources: '[{"id":"1","title":"Test Article","url":"https://example.com"}]',
      }

      const result = parse(attrs)

      expect(result).not.toBeNull()
      expect(result?.widget).toBe('citation')
      expect(typeof result?.args.sources).toBe('string')
      expect(result?.args.sources).toBe(attrs.sources)
    })

    it('parses multiple sources correctly', () => {
      const attrs = {
        sources: JSON.stringify([
          { id: '1', title: 'First', url: 'https://one.com', isPrimary: true },
          { id: '2', title: 'Second', url: 'https://two.com' },
        ]),
      }

      const result = parse(attrs)

      expect(result).not.toBeNull()
      expect(typeof result?.args.sources).toBe('string')
      expect(result?.args.sources).toBe(attrs.sources)
    })

    it('returns null for missing sources attribute', () => {
      const attrs = {}

      const result = parse(attrs)

      expect(result).toBeNull()
    })

    it('returns null for empty sources string', () => {
      const attrs = {
        sources: '',
      }

      const result = parse(attrs)

      expect(result).toBeNull()
    })

    it('parses sources with optional fields', () => {
      const attrs = {
        sources: JSON.stringify([
          {
            id: '1',
            title: 'Article',
            url: 'https://example.com',
            siteName: 'Example',
            favicon: 'https://example.com/icon.png',
            isPrimary: true,
          },
        ]),
      }

      const result = parse(attrs)

      expect(result).not.toBeNull()
      expect(typeof result?.args.sources).toBe('string')
      expect(result?.args.sources).toBe(attrs.sources)
    })
  })

  describe('security validation', () => {
    it('rejects javascript: URLs at parse time', () => {
      const attrs = {
        sources: JSON.stringify([{ id: '1', title: 'XSS', url: 'javascript:alert(1)' }]),
      }

      const result = parse(attrs)

      expect(result).toBeNull()
    })

    it('rejects data: URLs at parse time', () => {
      const attrs = {
        sources: JSON.stringify([{ id: '1', title: 'XSS', url: 'data:text/html,<script>alert(1)</script>' }]),
      }

      const result = parse(attrs)

      expect(result).toBeNull()
    })

    it('rejects file: URLs at parse time', () => {
      const attrs = {
        sources: JSON.stringify([{ id: '1', title: 'File Access', url: 'file:///etc/passwd' }]),
      }

      const result = parse(attrs)

      expect(result).toBeNull()
    })

    it('rejects missing id field', () => {
      const attrs = {
        sources: JSON.stringify([{ title: 'Test', url: 'https://example.com' }]),
      }

      const result = parse(attrs)

      expect(result).toBeNull()
    })

    it('rejects missing title field', () => {
      const attrs = {
        sources: JSON.stringify([{ id: '1', url: 'https://example.com' }]),
      }

      const result = parse(attrs)

      expect(result).toBeNull()
    })

    it('rejects missing url field', () => {
      const attrs = {
        sources: JSON.stringify([{ id: '1', title: 'Test' }]),
      }

      const result = parse(attrs)

      expect(result).toBeNull()
    })

    it('rejects empty id string', () => {
      const attrs = {
        sources: JSON.stringify([{ id: '', title: 'Test', url: 'https://example.com' }]),
      }

      const result = parse(attrs)

      expect(result).toBeNull()
    })

    it('rejects javascript: in favicon URL', () => {
      const attrs = {
        sources: JSON.stringify([
          {
            id: '1',
            title: 'Test',
            url: 'https://example.com',
            favicon: 'javascript:alert(1)',
          },
        ]),
      }

      const result = parse(attrs)

      expect(result).toBeNull()
    })

    it('rejects malformed JSON', () => {
      const attrs = {
        sources: 'not-valid-json',
      }

      const result = parse(attrs)

      expect(result).toBeNull()
    })

    it('rejects empty array', () => {
      const attrs = {
        sources: '[]',
      }

      const result = parse(attrs)

      expect(result).toBeNull()
    })

    it('accepts valid https URLs', () => {
      const attrs = {
        sources: JSON.stringify([{ id: '1', title: 'Test', url: 'https://example.com' }]),
      }

      const result = parse(attrs)

      expect(result).not.toBeNull()
    })

    it('accepts valid http URLs', () => {
      const attrs = {
        sources: JSON.stringify([{ id: '1', title: 'Test', url: 'http://example.com' }]),
      }

      const result = parse(attrs)

      expect(result).not.toBeNull()
    })

    it('accepts base64-encoded JSON sources', () => {
      const json = JSON.stringify([{ id: '1', title: 'Test', url: 'https://example.com' }])
      const base64 = btoa(json)
      const attrs = {
        sources: base64,
      }

      const result = parse(attrs)

      expect(result).not.toBeNull()
    })
  })
})
