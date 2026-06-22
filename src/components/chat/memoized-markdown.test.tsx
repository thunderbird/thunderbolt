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
})
