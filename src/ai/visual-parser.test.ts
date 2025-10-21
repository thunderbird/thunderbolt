import { describe, expect, it } from 'bun:test'
import type { ContentPart } from './visual-parser'
import { parseContentParts } from './visual-parser'

describe('parseContentParts', () => {
  describe('plain text', () => {
    it('returns single text part for plain text', () => {
      const result = parseContentParts('Hello world')
      expect(result).toEqual([{ type: 'text', content: 'Hello world' }])
    })

    it('trims whitespace from plain text', () => {
      const result = parseContentParts('  Hello world  ')
      expect(result).toEqual([{ type: 'text', content: 'Hello world' }])
    })

    it('returns empty array for empty text', () => {
      const result = parseContentParts('')
      expect(result).toEqual([])
    })

    it('returns empty array for whitespace-only text', () => {
      const result = parseContentParts('   ')
      expect(result).toEqual([])
    })
  })

  describe('weather forecast visuals', () => {
    it('parses single weather forecast visual', () => {
      const text = '<weather-forecast location="Seattle" region="WA" country="USA" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
      ])
    })

    it('parses weather forecast with text before', () => {
      const text = 'Here is the weather: <weather-forecast location="Seattle" region="WA" country="USA" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        { type: 'text', content: 'Here is the weather:' },
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
      ])
    })

    it('parses weather forecast with text after', () => {
      const text = '<weather-forecast location="Seattle" region="WA" country="USA" /> Enjoy your day!'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
        { type: 'text', content: 'Enjoy your day!' },
      ])
    })

    it('parses weather forecast with text before and after', () => {
      const text = 'Weather update: <weather-forecast location="Seattle" region="WA" country="USA" /> Stay warm!'
      const result = parseContentParts(text)

      expect(result).toEqual([
        { type: 'text', content: 'Weather update:' },
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
        { type: 'text', content: 'Stay warm!' },
      ])
    })

    it('parses multiple weather forecasts', () => {
      const text =
        '<weather-forecast location="Seattle" region="WA" country="USA" /> and <weather-forecast location="Portland" region="OR" country="USA" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
        { type: 'text', content: 'and' },
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: {
              location: 'Portland',
              region: 'OR',
              country: 'USA',
            },
          },
        },
      ])
    })

    it('ignores weather forecast with missing required attributes', () => {
      const text = 'Before <weather-forecast location="Seattle" region="WA" /> After'
      const result = parseContentParts(text)

      // Invalid tags are removed from output, text around them is preserved
      expect(result).toEqual([
        { type: 'text', content: 'Before' },
        { type: 'text', content: 'After' },
      ])
    })
  })

  describe('link preview visuals', () => {
    it('parses single link preview', () => {
      const text = '<link-preview url="https://example.com" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'visual',
          visual: {
            visual: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
      ])
    })

    it('parses link preview with text before and after', () => {
      const text = 'Check out <link-preview url="https://example.com" /> for more info'
      const result = parseContentParts(text)

      expect(result).toEqual([
        { type: 'text', content: 'Check out' },
        {
          type: 'visual',
          visual: {
            visual: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
        { type: 'text', content: 'for more info' },
      ])
    })

    it('parses multiple link previews', () => {
      const text = '<link-preview url="https://a.com" /> and <link-preview url="https://b.com" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'visual',
          visual: {
            visual: 'link-preview',
            args: {
              url: 'https://a.com',
            },
          },
        },
        { type: 'text', content: 'and' },
        {
          type: 'visual',
          visual: {
            visual: 'link-preview',
            args: {
              url: 'https://b.com',
            },
          },
        },
      ])
    })

    it('ignores link preview with missing url', () => {
      const text = 'Before <link-preview /> After'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Before <link-preview /> After' }])
    })
  })

  describe('mixed visuals', () => {
    it('parses weather forecast and link preview in order', () => {
      const text =
        'Weather: <weather-forecast location="Seattle" region="WA" country="USA" /> and link: <link-preview url="https://example.com" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        { type: 'text', content: 'Weather:' },
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
        { type: 'text', content: 'and link:' },
        {
          type: 'visual',
          visual: {
            visual: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
      ])
    })

    it('parses link preview and weather forecast in order', () => {
      const text =
        '<link-preview url="https://example.com" /> then <weather-forecast location="Seattle" region="WA" country="USA" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'visual',
          visual: {
            visual: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
        { type: 'text', content: 'then' },
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
      ])
    })

    it('handles complex interleaving of text and visuals', () => {
      const text =
        'Start <weather-forecast location="A" region="B" country="C" /> middle <link-preview url="https://x.com" /> more text <weather-forecast location="D" region="E" country="F" /> end'
      const result = parseContentParts(text)

      expect(result).toEqual([
        { type: 'text', content: 'Start' },
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: { location: 'A', region: 'B', country: 'C' },
          },
        },
        { type: 'text', content: 'middle' },
        {
          type: 'visual',
          visual: {
            visual: 'link-preview',
            args: { url: 'https://x.com' },
          },
        },
        { type: 'text', content: 'more text' },
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: { location: 'D', region: 'E', country: 'F' },
          },
        },
        { type: 'text', content: 'end' },
      ])
    })
  })

  describe('streaming scenarios (incomplete tags)', () => {
    it('removes incomplete tag at the end', () => {
      const text = 'Some text <weath'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Some text' }])
    })

    it('removes incomplete tag with partial tag name', () => {
      const text = 'Some text <weather-fo'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Some text' }])
    })

    it('removes incomplete tag with partial attributes', () => {
      const text = 'Some text <weather-forecast location="Seattle'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Some text' }])
    })

    it('removes incomplete tag with complete attributes but missing close', () => {
      const text = 'Some text <weather-forecast location="Seattle" region="WA" country="USA"'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Some text' }])
    })

    it('removes incomplete tag when only incomplete tag exists', () => {
      const text = '<weath'
      const result = parseContentParts(text)

      expect(result).toEqual([])
    })

    it('preserves complete visuals before incomplete tag', () => {
      const text = '<weather-forecast location="Seattle" region="WA" country="USA" /> Some text <link'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
        { type: 'text', content: 'Some text' },
      ])
    })
  })

  describe('extensibility', () => {
    it('ignores unregistered visual tags', () => {
      const text = 'Before <unknown-visual foo="bar" /> After'
      const result = parseContentParts(text)

      // Unregistered tags are silently removed
      expect(result).toEqual([
        { type: 'text', content: 'Before' },
        { type: 'text', content: 'After' },
      ])
    })

    it('handles mix of registered and unregistered tags', () => {
      const text =
        '<link-preview url="https://example.com" /> <unknown-tag x="y" /> <weather-forecast location="Seattle" region="WA" country="USA" />'
      const result = parseContentParts(text)

      // Only registered tags should be included
      expect(result).toEqual([
        {
          type: 'visual',
          visual: {
            visual: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
      ])
    })
  })

  describe('edge cases', () => {
    it('handles tags with forward slashes in attribute values', () => {
      const text = '<link-preview url="https://example.com/path/to/page" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'visual',
          visual: {
            visual: 'link-preview',
            args: {
              url: 'https://example.com/path/to/page',
            },
          },
        },
      ])
    })

    it('handles consecutive visuals without text between', () => {
      const text =
        '<weather-forecast location="Seattle" region="WA" country="USA" /><link-preview url="https://example.com" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
        {
          type: 'visual',
          visual: {
            visual: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
      ])
    })

    it('handles whitespace between tag and attributes', () => {
      const text = '<weather-forecast  location="Seattle" region="WA" country="USA" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'visual',
          visual: {
            visual: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
      ])
    })

    it('rejects empty url attribute', () => {
      const text = '<link-preview url="" />'
      const result = parseContentParts(text)

      // Empty URLs are invalid and the tag is removed
      expect(result).toEqual([])
    })

    it('is case insensitive for tag names', () => {
      const text = '<LINK-PREVIEW url="https://example.com" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'visual',
          visual: {
            visual: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
      ])
    })

    it('preserves order when visuals appear in different orders', () => {
      const text1 =
        '<link-preview url="https://a.com" /> <weather-forecast location="Seattle" region="WA" country="USA" />'
      const result1 = parseContentParts(text1)

      const text2 =
        '<weather-forecast location="Seattle" region="WA" country="USA" /> <link-preview url="https://a.com" />'
      const result2 = parseContentParts(text2)

      expect(result1[0].type).toBe('visual')
      expect((result1[0] as ContentPart & { type: 'visual' }).visual.visual).toBe('link-preview')
      expect(result1[1].type).toBe('visual')
      expect((result1[1] as ContentPart & { type: 'visual' }).visual.visual).toBe('weather-forecast')

      expect(result2[0].type).toBe('visual')
      expect((result2[0] as ContentPart & { type: 'visual' }).visual.visual).toBe('weather-forecast')
      expect(result2[1].type).toBe('visual')
      expect((result2[1] as ContentPart & { type: 'visual' }).visual.visual).toBe('link-preview')
    })
  })
})
