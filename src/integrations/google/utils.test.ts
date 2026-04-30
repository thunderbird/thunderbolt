/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { buildRawMessage, extractBody, transformDriveQuery } from './utils'

/** Decode base64url-encoded raw email back to string */
const decodeRawMessage = (raw: string): string => {
  const base64 = raw.replace(/-/g, '+').replace(/_/g, '/')
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Encode a string as base64url, matching Gmail API body.data format */
const toGmailBase64 = (str: string): string => {
  const bytes = new TextEncoder().encode(str)
  return btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

describe('extractBody', () => {
  it('should decode ASCII body from Gmail payload', () => {
    const text = 'Hello, world!'
    const payload = { mimeType: 'text/plain', body: { data: toGmailBase64(text) } }
    expect(extractBody(payload, 'text/plain')).toBe(text)
  })

  it('should decode Unicode body with emoji and accented characters', () => {
    const text = 'Olá mundo! 🌍 日本語テスト'
    const payload = { mimeType: 'text/plain', body: { data: toGmailBase64(text) } }
    expect(extractBody(payload, 'text/plain')).toBe(text)
  })

  it('should return empty string for empty body data', () => {
    const payload = { mimeType: 'text/plain', body: { data: toGmailBase64('') } }
    expect(extractBody(payload, 'text/plain')).toBe('')
  })

  it('should return empty string for null payload', () => {
    expect(extractBody(null, 'text/plain')).toBe('')
  })

  it('should return empty string for malformed base64 data', () => {
    const payload = { mimeType: 'text/plain', body: { data: '!!!invalid!!!' } }
    expect(extractBody(payload, 'text/plain')).toBe('')
  })

  it('should decode base64url body containing special characters', () => {
    // This string produces + and / in standard base64, which become - and _ in base64url
    const text = 'Réponse: où est le café? Ça coûte 3€'
    const payload = { mimeType: 'text/plain', body: { data: toGmailBase64(text) } }
    // Verify the test data actually contains base64url characters
    expect(payload.body.data).toMatch(/[-_]/)
    expect(extractBody(payload, 'text/plain')).toBe(text)
  })
})

describe('buildRawMessage encoding', () => {
  it('should round-trip Unicode content through base64url encoding', () => {
    const raw = buildRawMessage({ to: 'a@b.com', subject: 'Café ☕', body: 'Ação 日本語 🎉' })
    const decoded = decodeRawMessage(raw)
    expect(decoded).toContain('Subject: Café ☕')
    expect(decoded).toContain('Ação 日本語 🎉')
  })

  it('should encode empty body without error', () => {
    const raw = buildRawMessage({ to: 'a@b.com', subject: 'Empty', body: '' })
    const decoded = decodeRawMessage(raw)
    expect(decoded).toContain('Subject: Empty')
  })
})

describe('buildRawMessage HTML detection', () => {
  const buildWithBody = (body: string) =>
    decodeRawMessage(buildRawMessage({ to: 'test@example.com', subject: 'Test', body }))

  it('should detect actual HTML tags as HTML', () => {
    expect(buildWithBody('<div>Hello</div>')).toContain('Content-Type: text/html')
    expect(buildWithBody('<p>Paragraph</p>')).toContain('Content-Type: text/html')
    expect(buildWithBody('<br>')).toContain('Content-Type: text/html')
    expect(buildWithBody('<html><body>Content</body></html>')).toContain('Content-Type: text/html')
    expect(buildWithBody('Hello <b>world</b>')).toContain('Content-Type: text/html')
  })

  it('should not detect plain text with angle brackets as HTML', () => {
    expect(buildWithBody('5 < 10 and 20 > 15')).toContain('Content-Type: text/plain')
    expect(buildWithBody('a < b > c')).toContain('Content-Type: text/plain')
    expect(buildWithBody('use the -> operator')).toContain('Content-Type: text/plain')
    expect(buildWithBody('x << y >> z')).toContain('Content-Type: text/plain')
  })

  it('should detect self-closing tags as HTML', () => {
    expect(buildWithBody('<br/>')).toContain('Content-Type: text/html')
    expect(buildWithBody('<img src="photo.jpg"/>')).toContain('Content-Type: text/html')
    expect(buildWithBody('<hr />')).toContain('Content-Type: text/html')
  })

  it('should treat plain text without angle brackets as plain text', () => {
    expect(buildWithBody('Hello, world!')).toContain('Content-Type: text/plain')
    expect(buildWithBody('No special characters here')).toContain('Content-Type: text/plain')
  })

  it('should treat email addresses in angle brackets as plain text', () => {
    expect(buildWithBody('Contact Support <support@example.com> for help')).toContain('Content-Type: text/plain')
  })

  it('should treat multiple email addresses in angle brackets as plain text', () => {
    expect(buildWithBody('From: John <john@example.com> To: Jane <jane@example.com>')).toContain(
      'Content-Type: text/plain',
    )
  })
})

describe('transformDriveQuery', () => {
  describe('Query passthrough behavior', () => {
    it('should return queries as-is without transformation', () => {
      // Valid Google Drive API syntax should be passed through unchanged
      expect(transformDriveQuery("name contains 'alessandro'")).toBe("name contains 'alessandro'")
      expect(transformDriveQuery("fullText contains 'meeting notes'")).toBe("fullText contains 'meeting notes'")
      expect(transformDriveQuery("mimeType = 'application/pdf'")).toBe("mimeType = 'application/pdf'")
      expect(transformDriveQuery("modifiedTime > '2024-01-01T00:00:00Z'")).toBe("modifiedTime > '2024-01-01T00:00:00Z'")
      expect(transformDriveQuery('trashed = false')).toBe('trashed = false')
    })

    it('should preserve complex queries with logical operators', () => {
      const complexQuery = "name contains 'contract' and mimeType = 'application/pdf' and trashed = false"
      expect(transformDriveQuery(complexQuery)).toBe(complexQuery)

      const orQuery = "name contains 'budget' or fullText contains 'financial'"
      expect(transformDriveQuery(orQuery)).toBe(orQuery)

      const groupedQuery =
        "(name contains 'report' or name contains 'summary') and modifiedTime > '2024-01-01T00:00:00Z'"
      expect(transformDriveQuery(groupedQuery)).toBe(groupedQuery)
    })

    it('should handle queries with special characters and quotes', () => {
      expect(transformDriveQuery("name contains 'Valentine\\'s Day'")).toBe("name contains 'Valentine\\'s Day'")
      expect(transformDriveQuery("fullText contains 'john@example.com'")).toBe("fullText contains 'john@example.com'")
      expect(transformDriveQuery("name contains 'file-name.pdf'")).toBe("name contains 'file-name.pdf'")
    })

    it('should handle parent and permission queries', () => {
      expect(transformDriveQuery("'folderId123' in parents")).toBe("'folderId123' in parents")
      expect(transformDriveQuery("'user@example.com' in owners")).toBe("'user@example.com' in owners")
      expect(transformDriveQuery("'user@example.com' in writers")).toBe("'user@example.com' in writers")
    })

    it('should handle property queries', () => {
      const propQuery = "properties has { key='department' and value='sales' }"
      expect(transformDriveQuery(propQuery)).toBe(propQuery)

      const appPropQuery = "appProperties has { key='version' and value='1.0' }"
      expect(transformDriveQuery(appPropQuery)).toBe(appPropQuery)
    })

    it('should handle boolean and date queries', () => {
      expect(transformDriveQuery('starred = true')).toBe('starred = true')
      expect(transformDriveQuery('sharedWithMe = false')).toBe('sharedWithMe = false')
      expect(transformDriveQuery("createdTime >= '2025-01-01T00:00:00Z'")).toBe("createdTime >= '2025-01-01T00:00:00Z'")
      expect(transformDriveQuery("viewedByMeTime < '2024-12-31T23:59:59Z'")).toBe(
        "viewedByMeTime < '2024-12-31T23:59:59Z'",
      )
    })

    it('should handle empty or whitespace-only queries', () => {
      expect(transformDriveQuery('')).toBe('')
      expect(transformDriveQuery('   ')).toBe('')
      expect(transformDriveQuery('\t\n')).toBe('')
    })

    it('should trim whitespace from queries', () => {
      expect(transformDriveQuery('  name contains "test"  ')).toBe('name contains "test"')
      expect(transformDriveQuery('\t\nfullText contains "content"\n\t')).toBe('fullText contains "content"')
    })
  })

  describe('Documentation examples should work as-is', () => {
    it('should handle all the examples from the schema documentation', () => {
      const examples = [
        "name contains 'report'",
        "mimeType = 'application/pdf'",
        "modifiedTime > '2025-01-01T00:00:00Z'",
        "name contains 'budget' and trashed = false",
        "(name contains 'report' or fullText contains 'summary') and modifiedTime > '2024-12-01T00:00:00Z'",
        "'parentFolderId' in parents",
        "starred = true and mimeType = 'application/vnd.google-apps.document'",
      ]

      examples.forEach((example) => {
        expect(transformDriveQuery(example)).toBe(example)
      })
    })
  })
})
