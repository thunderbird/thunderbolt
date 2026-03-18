import { describe, expect, it } from 'bun:test'
import { decodeHtmlEntities, extractMetadata } from './html'

describe('decodeHtmlEntities', () => {
  it('decodes named entities', () => {
    expect(decodeHtmlEntities('&amp; &lt; &gt; &quot; &apos;')).toBe('& < > " \'')
  })

  it('decodes numeric entities', () => {
    expect(decodeHtmlEntities('&#169;')).toBe('\u00A9')
  })

  it('decodes hex entities', () => {
    expect(decodeHtmlEntities('&#x27;')).toBe("'")
  })

  it('handles mixed content', () => {
    expect(decodeHtmlEntities('Hello &amp; welcome to &quot;the show&quot;')).toBe('Hello & welcome to "the show"')
  })

  it('avoids double-decoding &amp;', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;')
  })
})

describe('extractMetadata', () => {
  it('extracts OG metadata', () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="Test Title" />
          <meta property="og:description" content="Test Description" />
          <meta property="og:image" content="https://example.com/image.png" />
          <meta property="og:site_name" content="Test Site" />
        </head>
      </html>
    `
    const result = extractMetadata(html, 'https://example.com')
    expect(result).toEqual({
      title: 'Test Title',
      description: 'Test Description',
      image: 'https://example.com/image.png',
      siteName: 'Test Site',
    })
  })

  it('falls back to <title> and meta description when OG tags are present', () => {
    const html = `
      <html>
        <head>
          <title>Page Title</title>
          <meta name="description" content="Page description" />
          <meta property="og:image" content="/img.png" />
        </head>
      </html>
    `
    const result = extractMetadata(html, 'https://example.com')
    expect(result.title).toBe('Page Title')
    expect(result.description).toBe('Page description')
    expect(result.image).toBe('https://example.com/img.png')
  })

  it('returns all nulls when no social tags are present', () => {
    const html = `
      <html>
        <head>
          <title>Plain Page</title>
          <meta name="description" content="Just a plain page" />
        </head>
      </html>
    `
    const result = extractMetadata(html, 'https://example.com')
    expect(result).toEqual({ title: null, description: null, image: null, siteName: null })
  })

  it('resolves relative image URLs', () => {
    const html = `<meta property="og:image" content="/images/og.png" />`
    const result = extractMetadata(html, 'https://example.com/page')
    expect(result.image).toBe('https://example.com/images/og.png')
  })

  it('decodes HTML entities in metadata values', () => {
    const html = `<meta property="og:title" content="Tom &amp; Jerry&#39;s Show" />`
    const result = extractMetadata(html, 'https://example.com')
    expect(result.title).toBe("Tom & Jerry's Show")
  })

  it('handles reversed attribute order (content before property)', () => {
    const html = `<meta content="Reversed Title" property="og:title" />`
    const result = extractMetadata(html, 'https://example.com')
    expect(result.title).toBe('Reversed Title')
  })
})
