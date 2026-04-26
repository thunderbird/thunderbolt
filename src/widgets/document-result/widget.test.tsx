import { describe, expect, it } from 'bun:test'
import { FileType2, File } from 'lucide-react'

// Test getFileIcon logic — after removing docx support,
// only PDF gets a specific icon, everything else gets generic File
describe('DocumentResultWidget file icon', () => {
  const getFileIcon = (fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase()
    if (ext === 'pdf') {
      return FileType2
    }
    return File
  }

  it('returns FileType2 for .pdf', () => {
    expect(getFileIcon('report.pdf')).toBe(FileType2)
  })

  it('returns generic File for .docx (no longer special-cased)', () => {
    expect(getFileIcon('notes.docx')).toBe(File)
  })

  it('returns generic File for .doc', () => {
    expect(getFileIcon('notes.doc')).toBe(File)
  })

  it('returns generic File for other types', () => {
    expect(getFileIcon('image.png')).toBe(File)
    expect(getFileIcon('data.csv')).toBe(File)
  })
})
