/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { ExternalLinkDialogProvider } from './markdown-utils'
import { MemoizedMarkdown } from './memoized-markdown'

const renderMarkdown = (content: string) =>
  render(
    <ExternalLinkDialogProvider>
      <MemoizedMarkdown id="test" content={content} />
    </ExternalLinkDialogProvider>,
  )

describe('MemoizedMarkdown — LaTeX', () => {
  afterEach(cleanup)

  it('renders inline `$…$` math as KaTeX', () => {
    const { container } = renderMarkdown('The variable $a^3$ matters.')
    // remark-math + rehype-katex emit a `.katex` span; raw `$` text is consumed.
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).not.toContain('$a^3$')
  })

  it('renders block `$$…$$` math as a KaTeX display block', () => {
    const { container } = renderMarkdown('$$F = G \\frac{M_1 M_2}{R^2}$$')
    expect(container.querySelector('.katex-display')).not.toBeNull()
  })

  it('still renders ordinary GFM markdown alongside math', () => {
    const { container } = renderMarkdown('**bold** and $x^2$')
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('.katex')).not.toBeNull()
  })

  it('renders a single-line `$$…$$` equation amid prose as display math', () => {
    // A common model output shape: prose, then a standalone one-line equation,
    // then more prose. Normalization must promote it to display math.
    const content = 'Newton’s law:\n\n$$F = G \\frac{M_1 M_2}{R^2}$$\n\nwhere $G$ is the constant.'
    const { container } = renderMarkdown(content)
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.textContent).toContain('Newton’s law:')
    expect(container.textContent).toContain('where')
  })

  it('leaves a lone dollar sign (no closing delimiter) as plain text', () => {
    const { container } = renderMarkdown('It costs $5 to enter.')
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('$5 to enter.')
  })

  it('renders LaTeX `\\(…\\)` inline delimiters as KaTeX', () => {
    const { container } = renderMarkdown('The variable \\(a^3\\) matters.')
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).not.toContain('\\(')
  })

  it('renders LaTeX `\\[…\\]` display delimiters as a KaTeX display block', () => {
    const { container } = renderMarkdown('\\[ x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\]')
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.textContent).not.toContain('\\[')
  })

  it('renders a multi-line `\\[…\\]` display block', () => {
    const content = 'Solve:\n\n\\[\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n\\]\n\nand done.'
    const { container } = renderMarkdown(content)
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.textContent).toContain('Solve:')
    expect(container.textContent).toContain('and done.')
  })

  it('leaves a `$$…$$` line inside a fenced code block as literal source', () => {
    const { container } = renderMarkdown('```\n$$E = mc^2$$\n```')
    // Not rendered as math, and the source text is preserved verbatim (not
    // rewritten with extra newlines).
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.querySelector('code')?.textContent).toContain('$$E = mc^2$$')
  })

  it('leaves LaTeX delimiters inside an inline code span as literal source', () => {
    const { container } = renderMarkdown('Write inline math as `\\(x\\)` in LaTeX.')
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('\\(x\\)')
  })

  it('treats two currency amounts in one sentence as literal text, not math', () => {
    const { container } = renderMarkdown('It costs $5 and $10 total.')
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('$5 and $10')
  })

  it('keeps currency literal while still rendering real math in the same sentence', () => {
    const { container } = renderMarkdown('It costs $5 but $x^2$ is math.')
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).toContain('$5')
  })

  it('renders inline math that starts with a digit (e.g. a physical constant)', () => {
    const { container } = renderMarkdown('G = $6.674 \\times 10^{-11}$ N·m²/kg².')
    expect(container.querySelector('.katex')).not.toBeNull()
    // The literal `$…$` delimiters are consumed by KaTeX, not shown as text.
    expect(container.textContent).not.toContain('$6.674')
  })

  it('renders a bare-decimal inline expression as math', () => {
    const { container } = renderMarkdown('Pi is about $3.14159$ in value.')
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).not.toContain('$3.14159$')
  })

  it('converts a multi-line `\\(…\\)` inline expression to KaTeX', () => {
    const { container } = renderMarkdown('Here \\(a +\nb\\) inline.')
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).not.toContain('\\(')
  })

  it('keeps a promoted `$$…$$` equation inside its list item (preserves indent)', () => {
    const { container } = renderMarkdown('1. First step\n\n   $$E = mc^2$$\n\n2. Second step')
    expect(container.querySelector('.katex-display')).not.toBeNull()
    // The equation stays a continuation of item 1 — the list isn't ended early.
    expect(container.querySelectorAll('li').length).toBe(2)
    expect(container.textContent).toContain('First step')
    expect(container.textContent).toContain('Second step')
  })

  it('keeps a promoted `\\[…\\]` equation inside its list item', () => {
    const { container } = renderMarkdown('1. First\n\n   \\[ a^2 + b^2 = c^2 \\]\n\n2. Second')
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.querySelectorAll('li').length).toBe(2)
  })
  it('leaves an empty `\\( \\)` as text instead of emitting a bare $$', () => {
    const { container } = renderMarkdown('It is \\( \\) and more text follows.')
    expect(container.querySelector('.katex-display')).toBeNull()
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('and more text follows.')
  })
})
