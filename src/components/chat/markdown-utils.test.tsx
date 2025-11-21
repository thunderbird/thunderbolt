import { render } from '@testing-library/react'
import { describe, expect, test } from 'bun:test'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { markdownComponents } from './markdown-utils'

describe('markdownComponents', () => {
  describe('basic <br> tag handling', () => {
    test('renders text without <br> tags unchanged', () => {
      const content = 'Simple text without breaks'
      const { container } = render(<ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>)

      expect(container.textContent).toBe('Simple text without breaks')
      expect(container.querySelectorAll('br')).toHaveLength(0)
    })

    test('converts single <br> tag to line break', () => {
      const content = 'Line 1<br />Line 2'
      const { container } = render(<ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>)

      expect(container.textContent).toBe('Line 1Line 2')
      expect(container.querySelectorAll('br')).toHaveLength(1)
    })

    test('converts multiple <br> tags to line breaks', () => {
      const content = 'Line 1<br />Line 2<br />Line 3'
      const { container } = render(<ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>)

      expect(container.textContent).toBe('Line 1Line 2Line 3')
      expect(container.querySelectorAll('br')).toHaveLength(2)
    })

    test('handles various <br> tag formats', () => {
      const content = 'Line 1<br />Line 2<br/>Line 3<br>Line 4'
      const { container } = render(<ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>)

      expect(container.querySelectorAll('br')).toHaveLength(3)
    })

    test('handles case insensitive <br> tags', () => {
      const content = 'Line 1<BR>Line 2'
      const { container } = render(<ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>)

      expect(container.textContent).toBe('Line 1Line 2')
      expect(container.querySelectorAll('br')).toHaveLength(1)
    })
  })

  describe('table cells - primary bug fix', () => {
    test('converts <br> tags in table cells with bullet lists', () => {
      const markdown = `
| Column |
|--------|
| • Item 1<br>• Item 2<br>• Item 3 |
`
      const { container } = render(
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {markdown}
        </ReactMarkdown>,
      )

      const td = container.querySelector('td')
      expect(td?.querySelectorAll('br')).toHaveLength(2)
      expect(td?.textContent).toBe('• Item 1• Item 2• Item 3')
    })

    test('handles multiple table cells with <br> tags', () => {
      const markdown = `
| Col 1 | Col 2 |
|-------|-------|
| A<br>B | C<br>D |
`
      const { container } = render(
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {markdown}
        </ReactMarkdown>,
      )

      const cells = container.querySelectorAll('td')
      expect(cells).toHaveLength(2)
      expect(cells[0]?.querySelectorAll('br')).toHaveLength(1)
      expect(cells[1]?.querySelectorAll('br')).toHaveLength(1)
    })

    test('converts <br> tags in table headers', () => {
      const markdown = `
| Header<br>Line 2 |
|------------------|
| Cell |
`
      const { container } = render(
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {markdown}
        </ReactMarkdown>,
      )

      const th = container.querySelector('th')
      expect(th?.querySelectorAll('br')).toHaveLength(1)
      expect(th?.textContent).toBe('HeaderLine 2')
    })
  })

  describe('list items', () => {
    test('converts <br> tags in list items', () => {
      const markdown = `
- Item 1<br>continued
- Item 2<br>continued
`
      const { container } = render(<ReactMarkdown components={markdownComponents}>{markdown}</ReactMarkdown>)

      const listItems = container.querySelectorAll('li')
      expect(listItems).toHaveLength(2)
      expect(listItems[0]?.querySelectorAll('br')).toHaveLength(1)
      expect(listItems[1]?.querySelectorAll('br')).toHaveLength(1)
    })
  })

  describe('edge cases', () => {
    test('handles consecutive <br> tags', () => {
      const content = 'Text<br><br>More text'
      const { container } = render(<ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>)

      expect(container.querySelectorAll('br')).toHaveLength(2)
    })

    test('preserves other HTML-like text', () => {
      const content = 'Text with <div> tags'
      const { container } = render(<ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>)

      expect(container.textContent).toContain('Text with')
      expect(container.querySelectorAll('br')).toHaveLength(0)
    })

    test('handles array children with multiple <br> tags without creating nested arrays', () => {
      // This test verifies flatMap correctly flattens results when processing array children
      const markdown = 'Text with <br> breaks'
      const { container } = render(<ReactMarkdown components={markdownComponents}>{markdown}</ReactMarkdown>)

      // Should render flat structure, not nested arrays
      const paragraph = container.querySelector('p')
      expect(paragraph?.childNodes.length).toBeGreaterThan(1)
      expect(container.querySelectorAll('br')).toHaveLength(1)
    })
  })

  describe('real-world scenario from bug report', () => {
    test('handles table with bullet-pointed lists in cells', () => {
      const markdown = `
| Category | Species |
|----------|---------|
| Annuals | • Pansy<br>• Snapdragon<br>• Calendula |
| Perennials | • Hosta<br>• Daylily |
`
      const { container } = render(
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {markdown}
        </ReactMarkdown>,
      )

      const cells = container.querySelectorAll('td')
      const annualsCell = cells[1]
      const perennialsCell = cells[3]

      expect(annualsCell?.querySelectorAll('br')).toHaveLength(2)
      expect(annualsCell?.textContent).toContain('Pansy')
      expect(annualsCell?.textContent).toContain('Snapdragon')
      expect(annualsCell?.textContent).toContain('Calendula')

      expect(perennialsCell?.querySelectorAll('br')).toHaveLength(1)
      expect(perennialsCell?.textContent).toContain('Hosta')
      expect(perennialsCell?.textContent).toContain('Daylily')
    })

    test('handles mixed markdown formatting with <br> tags', () => {
      const markdown = '**Bold text**<br>*Italic text*<br>Regular text'

      const { container } = render(<ReactMarkdown components={markdownComponents}>{markdown}</ReactMarkdown>)

      expect(container.querySelector('strong')).toBeTruthy()
      expect(container.querySelector('em')).toBeTruthy()
      expect(container.querySelectorAll('br')).toHaveLength(2)
    })
  })
})
