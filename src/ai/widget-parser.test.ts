/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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

    it('removes lone < at the end (potential widget start)', () => {
      const text = 'Some text <'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Some text' }])
    })

    it('removes partial <w prefix at the end', () => {
      const text = 'Some text <w'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Some text' }])
    })

    it('removes partial <wi prefix at the end', () => {
      const text = 'Some text <wi'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Some text' }])
    })

    it('removes partial <widget prefix at the end (without colon)', () => {
      const text = 'Some text <widget'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Some text' }])
    })

    it('does not remove non-widget HTML tags like <div', () => {
      const text = 'Some text <div'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Some text <div' }])
    })

    it('does not remove < followed by space', () => {
      const text = '5 < 10'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: '5 < 10' }])
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

  describe('connect-integration widgets', () => {
    it('parses connect-integration with all attributes', () => {
      const text =
        '<widget:connect-integration provider="google" service="email" reason="to check your inbox" override="" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'connect-integration',
            args: {
              provider: 'google',
              service: 'email',
              reason: 'to check your inbox',
              override: '',
            },
          },
        },
      ])
    })

    it('parses connect-integration with empty provider and reason', () => {
      const text = '<widget:connect-integration provider="" service="email" reason="" override="" />'
      const result = parseContentParts(text)

      expect(result).toEqual([
        {
          type: 'widget',
          widget: {
            widget: 'connect-integration',
            args: {
              provider: '',
              service: 'email',
              reason: '',
              override: '',
            },
          },
        },
      ])
    })

    it('rejects connect-integration with missing attributes', () => {
      const text1 = '<widget:connect-integration service="email" reason="" />'
      const result1 = parseContentParts(text1)
      // When widget fails to parse, it's ignored and returns empty array
      expect(result1).toEqual([])

      const text2 = '<widget:connect-integration provider="google" reason="" />'
      const result2 = parseContentParts(text2)
      expect(result2).toEqual([])

      // With text before, invalid widget is ignored but text remains
      const text3 = 'Some text <widget:connect-integration service="email" reason="" />'
      const result3 = parseContentParts(text3)
      expect(result3).toEqual([{ type: 'text', content: 'Some text' }])
    })
  })

  describe('single-quoted attributes', () => {
    it('parses citation with single-quoted JSON sources', () => {
      const json = '[{"id":"1","title":"Test","url":"https://example.com","siteName":"Example"}]'
      const text = `Some fact. <widget:citation sources='${json}' />`
      const result = parseContentParts(text)

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({ type: 'text', content: 'Some fact.' })
      expect(result[1]).toEqual({
        type: 'widget',
        widget: { widget: 'citation', args: { sources: json } },
      })
    })

    it('parses link preview with double-quoted attributes alongside citation with single-quoted', () => {
      const json = '[{"id":"1","title":"Test","url":"https://a.com"}]'
      const text = `Link: <widget:link-preview url="https://b.com" /> Fact. <widget:citation sources='${json}' />`
      const result = parseContentParts(text)

      expect(result).toHaveLength(4)
      expect(result[0]).toEqual({ type: 'text', content: 'Link:' })
      expect((result[1] as { type: 'widget'; widget: { widget: string } }).widget.widget).toBe('link-preview')
      expect(result[2]).toEqual({ type: 'text', content: 'Fact.' })
      expect((result[3] as { type: 'widget'; widget: { widget: string } }).widget.widget).toBe('citation')
    })

    it("handles apostrophe in JSON title (NASA's Mission)", () => {
      const json = `[{"id":"1","title":"NASA's Mission","url":"https://nasa.gov","siteName":"NASA"}]`
      const text = `Space exploration advances. <widget:citation sources='${json}' />`
      const result = parseContentParts(text)

      expect(result).toHaveLength(2)
      expect(result[1]).toEqual({
        type: 'widget',
        widget: { widget: 'citation', args: { sources: json } },
      })
    })

    it("handles multiple apostrophes in JSON (Rock 'n' Roll)", () => {
      const json = `[{"id":"1","title":"Rock 'n' Roll History","url":"https://music.com","siteName":"Music DB"}]`
      const text = `Music evolved. <widget:citation sources='${json}' />`
      const result = parseContentParts(text)

      expect(result).toHaveLength(2)
      expect(result[1]).toEqual({
        type: 'widget',
        widget: { widget: 'citation', args: { sources: json } },
      })
    })

    it("handles apostrophe in siteName (McDonald's)", () => {
      const json = `[{"id":"1","title":"Earnings Report","url":"https://mcdonalds.com","siteName":"McDonald's"}]`
      const text = `Revenue grew. <widget:citation sources='${json}' />`
      const result = parseContentParts(text)

      expect(result).toHaveLength(2)
      expect(result[1]).toEqual({
        type: 'widget',
        widget: { widget: 'citation', args: { sources: json } },
      })
    })
  })

  describe('single-quoted attributes security', () => {
    it('rejects attribute with excess closing brackets (negative depth attack)', () => {
      const json = `}}}}{"injected":"xss"}`
      const text = `Fact. <widget:citation sources='${json}' />`
      const result = parseContentParts(text)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ type: 'text', content: 'Fact.' })
    })

    it('rejects attribute with unmatched opening brackets', () => {
      const json = `[[[{"id":"1"}`
      const text = `Fact. <widget:citation sources='${json}' />`
      const result = parseContentParts(text)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ type: 'text', content: 'Fact.' })
    })

    it('rejects attribute with mismatched brackets (more closes than opens)', () => {
      const json = `}{"id":"1","title":"Test","url":"https://example.com"}`
      const text = `Info. <widget:citation sources='${json}' />`
      const result = parseContentParts(text)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ type: 'text', content: 'Info.' })
    })

    it('accepts valid JSON with balanced brackets in single quotes', () => {
      const json = `[{"id":"1","title":"Test","url":"https://example.com"}]`
      const text = `Fact. <widget:citation sources='${json}' />`
      const result = parseContentParts(text)

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({ type: 'text', content: 'Fact.' })
      expect(result[1]).toEqual({
        type: 'widget',
        widget: { widget: 'citation', args: { sources: json } },
      })
    })

    it('rejects empty JSON array in single quotes', () => {
      const json = `[]`
      const text = `Data. <widget:citation sources='${json}' />`
      const result = parseContentParts(text)

      // Empty arrays are invalid (at least one source required)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ type: 'text', content: 'Data.' })
    })
  })

  describe('bracket citation stripping', () => {
    it('strips OpenAI-style bracket citations', () => {
      const text = 'The AI Act was passed【2†title】.'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'The AI Act was passed.' }])
    })

    it('strips multiple bracket citations', () => {
      const text = 'First fact【1†source】 and second fact【3†source】.'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'First fact and second fact.' }])
    })

    it('strips bracket citations alongside valid widget citations', () => {
      const json = '[{"id":"1","title":"Test","url":"https://example.com"}]'
      const text = `AI regulation passed【2†title】 today. <widget:citation sources='${json}' />`
      const result = parseContentParts(text)

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({ type: 'text', content: 'AI regulation passed today.' })
      expect(result[1].type).toBe('widget')
    })

    it('strips numbered bracket citations', () => {
      const text = 'Fact【12】 and another【3】.'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Fact and another.' }])
    })

    it('strips bracket with dagger and title', () => {
      const text = 'The EU passed the AI Act【6†title】.'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'The EU passed the AI Act.' }])
    })

    it('preserves legitimate CJK brackets', () => {
      const text = '価格は【税込み】です'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: '価格は【税込み】です' }])
    })

    it('preserves text when no bracket citations present', () => {
      const text = 'Normal text without any brackets.'
      const result = parseContentParts(text)

      expect(result).toEqual([{ type: 'text', content: 'Normal text without any brackets.' }])
    })
  })

  describe('text with [N] citations and widget tags', () => {
    it('produces both text parts with [N] citations and widget parts', () => {
      const text =
        "Here's a demo:\n\n- Inline link [1]\n\n" + '<widget:link-preview url="https://example.com" source="1" />'
      const result = parseContentParts(text)

      const textParts = result.filter((p) => p.type === 'text')
      const widgetParts = result.filter((p) => p.type === 'widget')

      expect(textParts.length).toBeGreaterThanOrEqual(1)
      expect(widgetParts.length).toBeGreaterThanOrEqual(1)

      expect(textParts.some((p) => p.type === 'text' && p.content.includes('[1]'))).toBe(true)
      expect(widgetParts.some((p) => p.type === 'widget' && p.widget.widget === 'link-preview')).toBe(true)
    })

    it('preserves multiple widget parts after text with multiple [N] citations', () => {
      const text = [
        'Sources [1] and [2] confirm this.',
        '<widget:link-preview url="https://a.com" source="1" />',
        '<widget:link-preview url="https://b.com" source="2" />',
      ].join('\n\n')
      const result = parseContentParts(text)

      const textParts = result.filter((p) => p.type === 'text')
      const widgetParts = result.filter((p) => p.type === 'widget')

      expect(textParts.length).toBeGreaterThanOrEqual(1)
      expect(widgetParts).toHaveLength(2)
    })

    it('preserves widget order relative to text when citations are present', () => {
      const text =
        'First point [1].\n\n' +
        '<widget:link-preview url="https://first.com" source="1" />\n\n' +
        'Second point [2].\n\n' +
        '<widget:link-preview url="https://second.com" source="2" />'
      const result = parseContentParts(text)

      expect(result.length).toBeGreaterThanOrEqual(4)
      expect(result[0].type).toBe('text')
      expect(result[1].type).toBe('widget')
      expect(result[2].type).toBe('text')
      expect(result[3].type).toBe('widget')
    })
  })
})
