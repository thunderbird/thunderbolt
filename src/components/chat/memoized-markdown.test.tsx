/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { ExternalLinkDialogProvider } from './markdown-utils'
import { MemoizedMarkdown } from './memoized-markdown'

// Warm the lazily-loaded math chunk so the component's dynamic `import()` resolves
// from the module cache within a flush, rather than racing a cold module load.
import 'katex/dist/katex.min.css'
import 'rehype-katex'
import 'remark-math'

const renderMarkdown = (content: string) =>
  render(
    <ExternalLinkDialogProvider>
      <MemoizedMarkdown id="test" content={content} />
    </ExternalLinkDialogProvider>,
  )

// KaTeX is lazy-loaded (its ~70KB chunk ships only when a block has math), so
// math renders after an async re-render rather than synchronously. Flush the
// pending dynamic imports + setState by draining the fake clock inside `act`.
// The load is a chain of async boundaries — effect → loadMathPlugins() →
// Promise.all of three dynamic import()s → setState → re-render — and draining
// one tick can schedule the next, so a single pass isn't enough. Looping settles
// the whole chain; 5 is a comfortable upper bound (the chain is ~3–4 deep).
const flushLazyLoad = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => await getClock().runAllAsync())
  }
}

describe('MemoizedMarkdown — LaTeX', () => {
  afterEach(cleanup)

  it('renders inline `$…$` math as KaTeX', async () => {
    const { container } = renderMarkdown('The variable $a^3$ matters.')
    // remark-math + rehype-katex emit a `.katex` span; raw `$` text is consumed.
    await flushLazyLoad()
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).not.toContain('$a^3$')
  })

  it('renders block `$$…$$` math as a KaTeX display block', async () => {
    const { container } = renderMarkdown('$$F = G \\frac{M_1 M_2}{R^2}$$')
    await flushLazyLoad()
    expect(container.querySelector('.katex-display')).not.toBeNull()
  })

  it('still renders ordinary GFM markdown alongside math', async () => {
    const { container } = renderMarkdown('**bold** and $x^2$')
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    await flushLazyLoad()
    expect(container.querySelector('.katex')).not.toBeNull()
  })

  it('renders a single-line `$$…$$` equation amid prose as display math', async () => {
    // A common model output shape: prose, then a standalone one-line equation,
    // then more prose. Normalization must promote it to display math.
    const content = 'Newton’s law:\n\n$$F = G \\frac{M_1 M_2}{R^2}$$\n\nwhere $G$ is the constant.'
    const { container } = renderMarkdown(content)
    await flushLazyLoad()
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.textContent).toContain('Newton’s law:')
    expect(container.textContent).toContain('where')
  })

  it('leaves a lone dollar sign (no closing delimiter) as plain text', async () => {
    const { container } = renderMarkdown('It costs $5 to enter.')
    // Flush first: if detection wrongly matched math here, KaTeX would load and
    // render only after the async import — so the null assertion is only
    // meaningful once a would-be load has had the chance to complete.
    await flushLazyLoad()
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('$5 to enter.')
  })

  it('renders LaTeX `\\(…\\)` inline delimiters as KaTeX', async () => {
    const { container } = renderMarkdown('The variable \\(a^3\\) matters.')
    await flushLazyLoad()
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).not.toContain('\\(')
  })

  it('renders LaTeX `\\[…\\]` display delimiters as a KaTeX display block', async () => {
    const { container } = renderMarkdown('\\[ x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\]')
    await flushLazyLoad()
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.textContent).not.toContain('\\[')
  })

  it('renders a multi-line `\\[…\\]` display block', async () => {
    const content = 'Solve:\n\n\\[\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n\\]\n\nand done.'
    const { container } = renderMarkdown(content)
    await flushLazyLoad()
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.textContent).toContain('Solve:')
    expect(container.textContent).toContain('and done.')
  })

  it('leaves a `$$…$$` line inside a fenced code block as literal source', async () => {
    const { container } = renderMarkdown('```\n$$E = mc^2$$\n```')
    // The whole message parses to a single `code` node, so math detection is
    // skipped (`isCode` short-circuits `hasMath`) and the plugins never load.
    // Even if they did, remark-math never treats code-fence contents as math —
    // so no `.katex` is emitted and the source text is preserved verbatim.
    await flushLazyLoad()
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.querySelector('code')?.textContent).toContain('$$E = mc^2$$')
  })

  it('leaves LaTeX delimiters inside an inline code span as literal source', async () => {
    const { container } = renderMarkdown('Write inline math as `\\(x\\)` in LaTeX.')
    await flushLazyLoad()
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('\\(x\\)')
  })

  it('treats two currency amounts in one sentence as literal text, not math', async () => {
    const { container } = renderMarkdown('It costs $5 and $10 total.')
    await flushLazyLoad()
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('$5 and $10')
  })

  it('keeps currency literal while still rendering real math in the same sentence', async () => {
    const { container } = renderMarkdown('It costs $5 but $x^2$ is math.')
    await flushLazyLoad()
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).toContain('$5')
  })

  it('renders inline math that starts with a digit (e.g. a physical constant)', async () => {
    const { container } = renderMarkdown('G = $6.674 \\times 10^{-11}$ N·m²/kg².')
    await flushLazyLoad()
    expect(container.querySelector('.katex')).not.toBeNull()
    // The literal `$…$` delimiters are consumed by KaTeX, not shown as text.
    expect(container.textContent).not.toContain('$6.674')
  })

  it('renders a bare-decimal inline expression as math', async () => {
    const { container } = renderMarkdown('Pi is about $3.14159$ in value.')
    await flushLazyLoad()
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).not.toContain('$3.14159$')
  })

  it('converts a multi-line `\\(…\\)` inline expression to KaTeX', async () => {
    const { container } = renderMarkdown('Here \\(a +\nb\\) inline.')
    await flushLazyLoad()
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).not.toContain('\\(')
  })

  it('keeps a promoted `$$…$$` equation inside its list item (preserves indent)', async () => {
    const { container } = renderMarkdown('1. First step\n\n   $$E = mc^2$$\n\n2. Second step')
    await flushLazyLoad()
    expect(container.querySelector('.katex-display')).not.toBeNull()
    // The equation stays a continuation of item 1 — the list isn't ended early.
    expect(container.querySelectorAll('li').length).toBe(2)
    expect(container.textContent).toContain('First step')
    expect(container.textContent).toContain('Second step')
  })

  it('keeps a promoted `\\[…\\]` equation inside its list item', async () => {
    const { container } = renderMarkdown('1. First\n\n   \\[ a^2 + b^2 = c^2 \\]\n\n2. Second')
    await flushLazyLoad()
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.querySelectorAll('li').length).toBe(2)
  })
  it('leaves an empty `\\( \\)` as text instead of emitting a bare $$', async () => {
    const { container } = renderMarkdown('It is \\( \\) and more text follows.')
    await flushLazyLoad()
    expect(container.querySelector('.katex-display')).toBeNull()
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('and more text follows.')
  })
})
