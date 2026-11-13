/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  blankNonProse,
  type IncrementalMarkdownState,
  parseMarkdownIntoBlocks,
  parseMarkdownIntoBlocksIncremental,
} from './markdown-blocks'

/**
 * Realistic streamed-message shapes: prose, headings, nested lists, fenced code
 * (incl. one holding `$$`), GFM tables, block/inline math (both `$`/`$$` and the
 * `\[…\]`/`\(…\)` LaTeX drift the normalizer rewrites), currency, and blockquotes.
 * Each is streamed one character at a time so every open-construct intermediate
 * state (unterminated fence, half-typed table row, lone `$`, partial `\[`) is hit.
 */
const documents: Record<string, string> = {
  prose: 'The quick brown fox jumps over the lazy dog. It was a bright cold day in April.',
  headingsAndLists:
    '# Title\n\nIntro paragraph with **bold** and _italics_.\n\n' +
    '## Section\n\n- first\n- second\n  - nested a\n  - nested b\n- third\n\n' +
    '1. one\n2. two\n3. three\n\nClosing line.',
  fencedCode: 'Here is code:\n\n```ts\nconst x = 1\nconst y = 2\nconsole.log(x + y)\n```\n\nAnd after the fence.',
  codeShowingMath: 'Literal source:\n\n```\n$$E = mc^2$$ and \\(a\\)\n```\n\ndone.',
  indentedCode: 'Before.\n\n    const price = "$5"\n    const math = "\\(x\\)"\n\nAfter.',
  referenceDefinition: '[Read more][guide].\n\n[guide]: https://example.com\n\nClosing.',
  table:
    'Results:\n\n| Name | Score |\n|------|-------|\n| Alice | 90 |\n| Bob | 85 |\n| Carol | 78 |\n\nEnd of table.',
  blockMath: "Newton's law:\n\n$$F = G \\frac{M_1 M_2}{R^2}$$\n\nwhere $G$ is the constant.",
  latexDrift: 'Solve \\(a^2 + b^2 = c^2\\) then:\n\n\\[\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n\\]\n\nDone.',
  currencyAndMath: 'It costs $5 and $10 total, but $x^2$ is math and $3.14$ is a value.',
  blockquote: '> A quoted thought\n> spanning two lines.\n\nThen ordinary prose resumes here.',
  mathInList: '1. First step\n\n   $$E = mc^2$$\n\n2. Second step with \\(y = 2\\) inline.',
  // A trailing paragraph (`2`) that reinterprets as an ordered-list item merging
  // back into the preceding list — the classic incremental backward-merge trap.
  orderedListBackwardMerge: 'Intro.\n\n1. alpha\n\n2. beta\n\n3. gamma\n\nOutro paragraph.',
  unorderedListLoose: 'List:\n\n- one\n\n- two\n\n- three\n\nAfter the list.',
  blockquotesThenText: '> first quote\n\n> second quote\n\nplain paragraph after quotes.',
  deepNestedList: '- a\n  - b\n    - c\n      - d\n- e\n\nend',
  horizontalRules: 'Above.\n\n---\n\nBetween.\n\n***\n\nBelow.',
  setextHeadings: 'Big Title\n=========\n\nBody text.\n\nSubtitle\n--------\n\nMore body.',
  mixed:
    '# Report\n\nSummary [1].\n\n```py\nprint("hi")\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n' +
    'Then $$\\int_0^1 x\\,dx$$ and a final paragraph.',
}

describe('parseMarkdownIntoBlocksIncremental', () => {
  it('returns the same blocks as a full parse for a single call', () => {
    for (const doc of Object.values(documents)) {
      const { blocks } = parseMarkdownIntoBlocksIncremental(doc, null)
      expect(blocks).toEqual(parseMarkdownIntoBlocks(doc))
    }
  })

  it('matches a full parse block-for-block across every streaming prefix', () => {
    for (const [name, doc] of Object.entries(documents)) {
      let state: IncrementalMarkdownState | null = null
      for (let end = 1; end <= doc.length; end++) {
        const prefix = doc.slice(0, end)
        const result = parseMarkdownIntoBlocksIncremental(prefix, state)
        state = result.state
        expect({ name, prefix, blocks: result.blocks }).toEqual({
          name,
          prefix,
          blocks: parseMarkdownIntoBlocks(prefix),
        })
      }
    }
  })

  it('matches a full parse when streamed in word-sized chunks', () => {
    for (const doc of Object.values(documents)) {
      let state: IncrementalMarkdownState | null = null
      let acc = ''
      for (const chunk of doc.split(/(\s+)/)) {
        acc += chunk
        const result = parseMarkdownIntoBlocksIncremental(acc, state)
        state = result.state
        expect(result.blocks).toEqual(parseMarkdownIntoBlocks(acc))
      }
    }
  })

  it('reuses cached blocks when content is unchanged', () => {
    const doc = documents.headingsAndLists
    const first = parseMarkdownIntoBlocksIncremental(doc, null)
    const second = parseMarkdownIntoBlocksIncremental(doc, first.state)
    expect(second.blocks).toBe(first.blocks)
    expect(second.state).toBe(first.state)
  })

  it('falls back to a full parse when the new content is not an extension', () => {
    const first = parseMarkdownIntoBlocksIncremental(documents.table, null)
    const other = parseMarkdownIntoBlocksIncremental(documents.blockMath, first.state)
    expect(other.blocks).toEqual(parseMarkdownIntoBlocks(documents.blockMath))
  })

  it('handles an edit that shortens then regrows the content', () => {
    const full = documents.mixed
    const grown = parseMarkdownIntoBlocksIncremental(full, null)
    // A shorter prefix is not an extension of `full`, so it must full-parse.
    const shortened = parseMarkdownIntoBlocksIncremental(full.slice(0, 20), grown.state)
    expect(shortened.blocks).toEqual(parseMarkdownIntoBlocks(full.slice(0, 20)))
    // Growing again from the shortened state stays correct.
    const regrown = parseMarkdownIntoBlocksIncremental(full, shortened.state)
    expect(regrown.blocks).toEqual(parseMarkdownIntoBlocks(full))
  })

  it('produces an empty block list for empty content', () => {
    const { blocks } = parseMarkdownIntoBlocksIncremental('', null)
    expect(blocks).toEqual([])
  })

  // Regression inputs that a fuzzer found where a naive commit boundary diverged
  // from a full parse: normalization turning a paragraph into a blockquote that a
  // trailing `>` merges into, an ordered `2.` lazily continuing a paragraph, a
  // whitespace-only "blank" line (`\n\t\n`) that later dissolves, a trailing blank
  // line that grows, and CRLF line endings (whose `\r\n\r\n` blank line the
  // commit-boundary detection must still recognize).
  it.each([
    [
      'normalized math promotes into a blockquote a trailing `>` merges into',
      '*|---|---|\\[>|  \\]##   |---|---|``\\)\\)\\(|---|---|\n>',
    ],
    [
      'an ordered `2.` lazily continues the paragraph instead of starting a list',
      '| a | b |>$5* <div>||---|---|\n*| a | b |b\n2. <div>_> \n- \\',
    ],
    ['a whitespace-only blank line dissolves when a lazy line follows', 'b\\[a_`b``` \n\t\n---c'],
    ['a trailing blank line grows', 'Para A\n\n'],
    ['CRLF line endings normalize to LF', 'First\r\n\r\nSecond\r\nthird\r\n\r\nFourth'],
  ])('matches a full parse across every streaming prefix: %s', (_label, doc) => {
    let state: IncrementalMarkdownState | null = null
    for (let end = 1; end <= doc.length; end++) {
      const prefix = doc.slice(0, end)
      const result = parseMarkdownIntoBlocksIncremental(prefix, state)
      state = result.state
      expect(result.blocks).toEqual(parseMarkdownIntoBlocks(prefix))
    }
  })

  it('matches a full parse for randomly assembled documents streamed char-by-char', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 0x2f6e2b1
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const fragments = [
      'Some prose here.',
      '# Heading',
      '## Sub',
      '- bullet a\n- bullet b',
      '1. one\n2. two',
      '3',
      '```\ncode block\n```',
      '| h1 | h2 |\n|----|----|\n| v1 | v2 |',
      '> a quote',
      '$$a^2 + b^2$$',
      'Inline \\(x\\) math.',
      '\\[ y = x \\]',
      'It costs $5 today.',
      '---',
    ]
    for (let doc = 0; doc < 40; doc++) {
      const pieces: string[] = []
      const count = 2 + Math.floor(rand() * 5)
      for (let i = 0; i < count; i++) {
        pieces.push(fragments[Math.floor(rand() * fragments.length)])
      }
      const text = pieces.join('\n\n')
      let state: IncrementalMarkdownState | null = null
      for (let end = 1; end <= text.length; end++) {
        const prefix = text.slice(0, end)
        const result = parseMarkdownIntoBlocksIncremental(prefix, state)
        state = result.state
        expect({ doc, prefix, blocks: result.blocks }).toEqual({
          doc,
          prefix,
          blocks: parseMarkdownIntoBlocks(prefix),
        })
      }
    }
  })
})

describe('blankNonProse', () => {
  /** The prose left after blanking, whitespace collapsed — what a citation rewrite may touch. */
  const prose = (markdown: string) => blankNonProse(markdown).replace(/\s+/g, ' ').trim()

  it('blanks fenced code, inline code and every math delimiter, keeping length and newlines', () => {
    const markdown = 'Prose [1].\n\n```ts\nx[1]\n```\n\nInline `a[1]` and $b_1$, $$c$$, \\(d\\) and \\[e\\].'
    const blanked = blankNonProse(markdown)

    expect(prose(markdown)).toBe('Prose [1]. Inline and , , and .')
    expect(blanked).toHaveLength(markdown.length)
    expect(blanked.split('\n')).toHaveLength(markdown.split('\n').length)
  })

  it('runs an unclosed fence to the end', () => {
    expect(prose('Intro\n~~~\nstill [1] streaming')).toBe('Intro')
  })

  it('closes a fence only on the same character, at least as long', () => {
    expect(prose('````\n```\ninner\n```\n````\nafter')).toBe('after')
    expect(prose('~~~\n```\nx\n```\nstill code')).toBe('')
  })

  it('reads a backtick "fence" whose info string holds a backtick as inline code', () => {
    expect(prose('```pip install x``` is how [1].\n\nMore [2].')).toBe('is how [1]. More [2].')
  })

  it('never pairs inline-code backticks across a blank line', () => {
    expect(prose('Press the ` key [1].\n\nThen run `ls` [2].')).toBe('Press the ` key [1]. Then run [2].')
    expect(prose('Use `a\nb[1]` here')).toBe('Use here')
  })

  it('recognizes a fence opened on a list-item line', () => {
    expect(prose('- ```js\n  a[1]\n  ```\n\nText [3]')).toBe('Text [3]')
    expect(prose('1. ```bash\n   pip install x[1]\n   ```\n2. Then [2]')).toBe('2. Then [2]')
  })

  it('never pairs math delimiters across a blank line', () => {
    expect(prose('Arrays use the \\[ operator [1].\n\nSee also [2] and the \\] token.')).toBe(
      'Arrays use the \\[ operator [1]. See also [2] and the \\] token.',
    )
    expect(prose('Type \\( to open [1].\n \nThen \\) closes [2].')).toBe('Type \\( to open [1]. Then \\) closes [2].')
  })

  it('treats a CRLF blank line as a paragraph break', () => {
    expect(prose('Press ` key [1].\r\n\r\nThen `ls` [2].')).toBe('Press ` key [1]. Then [2].')
  })

  it('closes inline code only on a backtick run of the same length', () => {
    expect(prose('Use ``obj[1]` x`` here [1].')).toBe('Use here [1].')
    expect(prose('Use ``` [1] ` and more')).toBe('Use ``` [1] ` and more')
  })

  it('ignores backticks and dollars inside a fence', () => {
    expect(prose('```\n`$x\n```\nprose $5 and `ok`')).toBe('prose $5 and')
  })

  it('treats currency as prose', () => {
    expect(prose('Costs $5 and $10 [1].')).toBe('Costs $5 and $10 [1].')
  })
})
