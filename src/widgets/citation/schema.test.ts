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
      expect(result?.args.sources).toBe(attrs.sources)
    })

    it('accepts sources as string even if JSON is malformed (validation happens in widget component)', () => {
      const attrs = {
        sources: 'not-valid-json',
      }

      const result = parse(attrs)

      // Schema only validates that sources is a non-empty string
      // JSON parsing happens in the widget component
      expect(result).not.toBeNull()
      expect(result?.args.sources).toBe('not-valid-json')
    })
  })
})
