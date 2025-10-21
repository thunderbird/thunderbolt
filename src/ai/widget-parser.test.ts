import { describe, expect, it } from 'bun:test'
import type { ContentPart } from './widget-parser'
import { parseContentParts } from './widget-parser'

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

  describe('weather forecast widgets', () => {
    it('parses single weather forecast visual', () => {
      const text = '<widget:weather-forecast location="Seattle" region="WA" country="USA" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
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
      const text = 'Here is the weather: <widget:weather-forecast location="Seattle" region="WA" country="USA" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        { type: 'text', content: 'Here is the weather:' },
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
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
      const text = '<widget:weather-forecast location="Seattle" region="WA" country="USA" /> Enjoy your day!'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
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
      const text = 'Weather update: <widget:weather-forecast location="Seattle" region="WA" country="USA" /> Stay warm!'
      const result = parseContentParts(text)

      expect(result).toEqual([
        { type: 'text', content: 'Weather update:' },
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
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
        '<widget:weather-forecast location="Seattle" region="WA" country="USA" /> and <widget:weather-forecast location="Portland" region="OR" country="USA" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
        { type: 'text', content: 'and' },
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
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
      const text = 'Before <widget:weather-forecast location="Seattle" region="WA" /> After'
      const result = parseContentParts(text)

      // Invalid tags are removed from output, text around them is preserved
      expect(result).toEqual([
        { type: 'text', content: 'Before' },
        { type: 'text', content: 'After' },
      ])
    })
  })

  describe('link preview widgets', () => {
    it('parses single link preview', () => {
      const text = '<widget:link-preview url="https://example.com" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
      ])
    })

    it('parses link preview with text before and after', () => {
      const text = 'Check out <widget:link-preview url="https://example.com" /> for more info'
      const result = parseContentParts(text)

      expect(result).toEqual([
        { type: 'text', content: 'Check out' },
        {
          type: 'widget',
          widget: {
            widget: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
        { type: 'text', content: 'for more info' },
      ])
    })

    it('parses multiple link previews', () => {
      const text = '<widget:link-preview url="https://a.com" /> and <widget:link-preview url="https://b.com" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'link-preview',
            args: {
              url: 'https://a.com',
            },
          },
        },
        { type: 'text', content: 'and' },
        {
          type: 'widget',
          widget: {
            widget: 'link-preview',
            args: {
              url: 'https://b.com',
            },
          },
        },
      ])
    })

    it('ignores link preview with missing url', () => {
      const text = 'Before <widget:link-preview /> After'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Before <widget:link-preview /> After' }])
    })
  })

  describe('mixed widgets', () => {
    it('parses weather forecast and link preview in order', () => {
      const text =
        'Weather: <widget:weather-forecast location="Seattle" region="WA" country="USA" /> and link: <widget:link-preview url="https://example.com" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        { type: 'text', content: 'Weather:' },
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
        { type: 'text', content: 'and link:' },
        {
          type: 'widget',
          widget: {
            widget: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
      ])
    })

    it('parses link preview and weather forecast in order', () => {
      const text =
        '<widget:link-preview url="https://example.com" /> then <widget:weather-forecast location="Seattle" region="WA" country="USA" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
        { type: 'text', content: 'then' },
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
      ])
    })

    it('handles complex interleaving of text and widgets', () => {
      const text =
        'Start <widget:weather-forecast location="A" region="B" country="C" /> middle <widget:link-preview url="https://x.com" /> more text <widget:weather-forecast location="D" region="E" country="F" /> end'
      const result = parseContentParts(text)

      expect(result).toEqual([
        { type: 'text', content: 'Start' },
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
            args: { location: 'A', region: 'B', country: 'C' },
          },
        },
        { type: 'text', content: 'middle' },
        {
          type: 'widget',
          widget: {
            widget: 'link-preview',
            args: { url: 'https://x.com' },
          },
        },
        { type: 'text', content: 'more text' },
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
            args: { location: 'D', region: 'E', country: 'F' },
          },
        },
        { type: 'text', content: 'end' },
      ])
    })
  })

  describe('streaming scenarios (incomplete tags)', () => {
    it('removes incomplete tag at the end', () => {
      const text = 'Some text <widget:weath'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Some text' }])
    })

    it('removes incomplete tag with partial tag name', () => {
      const text = 'Some text <widget:weather-fo'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Some text' }])
    })

    it('removes incomplete tag with partial attributes', () => {
      const text = 'Some text <widget:weather-forecast location="Seattle'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Some text' }])
    })

    it('removes incomplete tag with complete attributes but missing close', () => {
      const text = 'Some text <widget:weather-forecast location="Seattle" region="WA" country="USA"'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Some text' }])
    })

    it('removes incomplete tag when only incomplete tag exists', () => {
      const text = '<widget:weath'
      const result = parseContentParts(text)

      expect(result).toEqual([])
    })

    it('preserves complete visuals before incomplete tag', () => {
      const text = '<widget:weather-forecast location="Seattle" region="WA" country="USA" /> Some text <widget:link'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
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
    it('ignores unregistered widget tags', () => {
      const text = 'Before <widget:unknown foo="bar" /> After'
      const result = parseContentParts(text)

      // Unregistered tags are silently removed
      expect(result).toEqual([
        { type: 'text', content: 'Before' },
        { type: 'text', content: 'After' },
      ])
    })

    it('handles mix of registered and unregistered tags', () => {
      const text =
        '<widget:link-preview url="https://example.com" /> <unknown-tag x="y" /> <widget:weather-forecast location="Seattle" region="WA" country="USA" />'
      const result = parseContentParts(text)

      // Only namespaced widget tags should be parsed; other tags are preserved as text
      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
        { type: 'text', content: '<unknown-tag x="y" />' },
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
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
      const text = '<widget:link-preview url="https://example.com/path/to/page" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'link-preview',
            args: {
              url: 'https://example.com/path/to/page',
            },
          },
        },
      ])
    })

    it('handles consecutive visuals without text between', () => {
      const text =
        '<widget:weather-forecast location="Seattle" region="WA" country="USA" /><widget:link-preview url="https://example.com" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
            args: {
              location: 'Seattle',
              region: 'WA',
              country: 'USA',
            },
          },
        },
        {
          type: 'widget',
          widget: {
            widget: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
      ])
    })

    it('handles whitespace between tag and attributes', () => {
      const text = '<widget:weather-forecast  location="Seattle" region="WA" country="USA" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'weather-forecast',
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
      const text = '<widget:link-preview url="" />'
      const result = parseContentParts(text)

      // Empty URLs are invalid and the tag is removed
      expect(result).toEqual([])
    })

    it('is case insensitive for tag names', () => {
      const text = '<WIDGET:LINK-PREVIEW url="https://example.com" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'link-preview',
            args: {
              url: 'https://example.com',
            },
          },
        },
      ])
    })

    it('preserves order when visuals appear in different orders', () => {
      const text1 =
        '<widget:link-preview url="https://a.com" /> <widget:weather-forecast location="Seattle" region="WA" country="USA" />'
      const result1 = parseContentParts(text1)

      const text2 =
        '<widget:weather-forecast location="Seattle" region="WA" country="USA" /> <widget:link-preview url="https://a.com" />'
      const result2 = parseContentParts(text2)

      expect(result1[0].type).toBe('widget')
      expect((result1[0] as ContentPart & { type: 'widget' }).widget.widget).toBe('link-preview')
      expect(result1[1].type).toBe('widget')
      expect((result1[1] as ContentPart & { type: 'widget' }).widget.widget).toBe('weather-forecast')

      expect(result2[0].type).toBe('widget')
      expect((result2[0] as ContentPart & { type: 'widget' }).widget.widget).toBe('weather-forecast')
      expect(result2[1].type).toBe('widget')
      expect((result2[1] as ContentPart & { type: 'widget' }).widget.widget).toBe('link-preview')
    })
  })
})
