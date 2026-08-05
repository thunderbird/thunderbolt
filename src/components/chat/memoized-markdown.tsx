/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type CSSProperties, memo, useEffect, useMemo, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PluggableList } from 'unified'

import { blockHasMath, type IncrementalMarkdownState, parseMarkdownIntoBlocksIncremental } from './markdown-blocks'
import { markdownComponents } from './markdown-utils'

// remark-gfm is small and used by every block, so it stays statically imported.
// remark-math + rehype-katex + the KaTeX stylesheet (~70KB gzip) are lazy-loaded
// only when a block actually contains math — see `loadMathPlugins`.

type MathPlugins = { remark: PluggableList[number]; rehype: PluggableList[number] }

// remark-math + rehype-katex + the KaTeX stylesheet make up their own chunk,
// loaded once (module-level cached promise) and reused across every block, and
// only when a block needs math — so the ~70KB never ships in the entry for the
// many messages that render no equations. The CSS is imported here so the
// stylesheet lands in the katex chunk rather than the entry.
let mathPluginsPromise: Promise<MathPlugins> | null = null
const loadMathPlugins = (): Promise<MathPlugins> => {
  mathPluginsPromise ??= (async () => {
    try {
      const [remark, rehype] = await Promise.all([
        import('remark-math'),
        import('rehype-katex'),
        import('katex/dist/katex.min.css'),
      ])
      return { remark: remark.default, rehype: rehype.default }
    } catch (error) {
      // Don't let a flaky import (bad network, stale chunk hash after a deploy)
      // poison the cache for the whole session — clear it so a later block retries.
      mathPluginsPromise = null
      throw error
    }
  })()
  return mathPluginsPromise
}

// Lazy-load the math plugins when a block needs them. Until they resolve the
// block renders without math (a brief FOUC of raw `$…$`, then a re-render into
// KaTeX). The cancelled flag guards against a setState after unmount.
const useMathPlugins = (enabled: boolean): MathPlugins | null => {
  const [plugins, setPlugins] = useState<MathPlugins | null>(null)
  useEffect(() => {
    if (!enabled || plugins) {
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const loaded = await loadMathPlugins()
        if (!cancelled) {
          setPlugins(loaded)
        }
      } catch (error) {
        // `loadMathPlugins` already cleared its cached promise, so a freshly
        // mounted block retries the import. Log rather than retry in place: this
        // block has no back-off, and re-running on every render would busy-loop
        // against a persistently failing chunk. The block renders raw `$…$`.
        console.error('memoized-markdown: failed to load KaTeX math plugins', error)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [enabled, plugins])
  return enabled ? plugins : null
}

const MemoizedMarkdownBlock = memo(
  ({ content, isCode, components }: { content: string; isCode: boolean; components: Components }) => {
    const hasMath = useMemo(() => !isCode && blockHasMath(content), [content, isCode])
    const mathPlugins = useMathPlugins(hasMath)
    const remarkPlugins: PluggableList = mathPlugins ? [remarkGfm, mathPlugins.remark] : [remarkGfm]
    const rehypePlugins: PluggableList = mathPlugins ? [mathPlugins.rehype] : []
    return (
      <div className="overflow-x-scroll">
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
          {content}
        </ReactMarkdown>
      </div>
    )
  },
  (prevProps, nextProps) => prevProps.content === nextProps.content && prevProps.components === nextProps.components,
)

MemoizedMarkdownBlock.displayName = 'MemoizedMarkdownBlock'

type MemoizedMarkdownProps = {
  content: string
  id: string
  components?: Components
}

export const MemoizedMarkdown = memo(({ content, id, components }: MemoizedMarkdownProps) => {
  // Thread incremental parse state across renders so a streamed message re-parses
  // only its last block + appended tail instead of the whole growing content.
  const parseStateRef = useRef<IncrementalMarkdownState | null>(null)
  const blocks = useMemo(() => {
    const { blocks, state } = parseMarkdownIntoBlocksIncremental(content, parseStateRef.current)
    // Render-phase ref write, safe by construction: parse state is a pure function
    // of `content`. StrictMode double-invocation and concurrent renders that never
    // commit therefore produce equally valid state. Worst case a discarded/stale
    // state isn't a clean prefix of the next content, so `parseMarkdownIntoBlocksIncremental`
    // just falls back to one full re-parse — never wrong output, only a one-render cost.
    parseStateRef.current = state
    return blocks
  }, [content])
  const resolvedComponents = components ?? markdownComponents

  return (
    <div
      className="prose prose-sm max-w-none dark:prose-invert"
      style={
        {
          // Override prose styles to match your design
          color: 'inherit',
          fontSize: 'inherit',
          lineHeight: 'inherit',
          // Ensure proper styling for markdown elements
          '--tw-prose-body': 'inherit',
          '--tw-prose-headings': 'inherit',
          '--tw-prose-lead': 'inherit',
          '--tw-prose-links': 'inherit',
          '--tw-prose-bold': 'inherit',
          '--tw-prose-counters': 'inherit',
          '--tw-prose-bullets': 'inherit',
          // Subtle divider — full-strength text color (`inherit`) makes <hr>s
          // read as heavy rules; use the theme's hairline border tone instead.
          // Light borders are faint against the white page, so light mode
          // keeps the border at full strength while dark dims it.
          '--tw-prose-hr': 'var(--color-border)',
          '--tw-prose-quotes': 'inherit',
          '--tw-prose-quote-borders': 'inherit',
          '--tw-prose-captions': 'inherit',
          '--tw-prose-code': 'inherit',
          '--tw-prose-pre-code': 'inherit',
          '--tw-prose-pre-bg': 'inherit',
          '--tw-prose-th-borders': 'inherit',
          '--tw-prose-td-borders': 'inherit',
          '--tw-prose-invert-body': 'inherit',
          '--tw-prose-invert-headings': 'inherit',
          '--tw-prose-invert-lead': 'inherit',
          '--tw-prose-invert-links': 'inherit',
          '--tw-prose-invert-bold': 'inherit',
          '--tw-prose-invert-counters': 'inherit',
          '--tw-prose-invert-bullets': 'inherit',
          '--tw-prose-invert-hr': 'color-mix(in oklab, var(--color-border) 60%, transparent)',
          '--tw-prose-invert-quotes': 'inherit',
          '--tw-prose-invert-quote-borders': 'inherit',
          '--tw-prose-invert-captions': 'inherit',
          '--tw-prose-invert-code': 'inherit',
          '--tw-prose-invert-pre-code': 'inherit',
          '--tw-prose-invert-pre-bg': 'inherit',
          '--tw-prose-invert-th-borders': 'inherit',
          '--tw-prose-invert-td-borders': 'inherit',
        } as CSSProperties
      }
    >
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock
          content={block.content}
          isCode={block.isCode}
          components={resolvedComponents}
          key={`${id}-block_${index}`}
        />
      ))}
    </div>
  )
})

MemoizedMarkdown.displayName = 'MemoizedMarkdown'
