/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  parseMarkdownIntoBlocksIncremental,
  type IncrementalMarkdownState,
} from '../../src/components/chat/markdown-blocks'
import { percentile } from './metrics'

const answer =
  '### Performance answer\n\nKeep interactions responsive by doing only necessary work.\n\n' +
  '- Measure before changing it.\n- Preserve keyboard and touch behavior.\n\n' +
  '```typescript\nconst total = values.reduce((sum, value) => sum + value, 0)\n```\n\n' +
  '| Operation | Result |\n| --- | --- |\n| Render | Complete |\n| Save | Complete |'
const history = Array.from({ length: 120 }, (_, index) =>
  index % 2 === 0 ? `Explain performance topic ${index + 1}: rendering and responsive interactions.` : answer,
)
const streamedAnswer = Array.from({ length: 6 }, () => answer).join('\n\n')
const samples = 21

/** Parse a saved conversation, as when its message components first mount. */
const openHistory = () =>
  history.reduce((count, markdown) => count + parseMarkdownIntoBlocksIncremental(markdown, null).blocks.length, 0)

/** Append fixed-size deltas to exercise reuse of already settled blocks. */
const streamAnswer = () => {
  let state: IncrementalMarkdownState | null = null
  for (let end = 16; end < streamedAnswer.length + 16; end += 16) {
    state = parseMarkdownIntoBlocksIncremental(streamedAnswer.slice(0, end), state).state
  }
  return state?.blocks.length ?? 0
}

/** Report isolated parser timings; these exclude React, browser layout, and CPU throttling. */
const measure = (name: string, run: () => number) => {
  for (let warmup = 0; warmup < 5; warmup++) {
    run()
  }
  const timings = Array.from({ length: samples }, () => {
    const started = performance.now()
    const blocks = run()
    return { ms: performance.now() - started, blocks }
  })
  const values = timings.map(({ ms }) => ms)
  return {
    name,
    samples,
    medianMs: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    blocks: timings[0].blocks,
  }
}

console.log(
  JSON.stringify(
    {
      runtime: `Bun ${Bun.version}`,
      measurements: [measure('open-120-message-history', openHistory), measure('stream-markdown-answer', streamAnswer)],
    },
    null,
    2,
  ),
)
