import { describe, expect, it } from 'bun:test'
import { transformDriveQuery } from './utils'

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
