/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const performanceStreamPrompt = 'Render the deterministic long markdown performance fixture.'
export const performanceStreamEnd = 'Performance stream complete.'
export const performanceStreamSections = 16
export const performanceStreamReply =
  Array.from({ length: performanceStreamSections }, (_, index) =>
    [
      `## Streaming section ${index + 1}`,
      'A responsive conversation keeps **typing**, menus, and scrolling usable while a long answer arrives. ' +
        'This repeatable fixture includes paragraphs, nested lists, fenced code, tables, and references.',
      '- Preserve input focus and the unsent draft.\n- Render completed blocks once.\n  - Keep the active suffix correct.',
      '```typescript\nconst measurements = [16, 17, 18]\nconst total = measurements.reduce((sum, value) => sum + value, 0)\n```',
      '| Interaction | Expected |\n| --- | --- |\n| Typing | Responsive |\n| Streaming | Complete |',
      `Read [the measurement notes][notes-${index + 1}] before interpreting these results.`,
      `[notes-${index + 1}]: https://example.com/measurements/${index + 1}`,
    ].join('\n\n'),
  ).join('\n\n') + `\n\n${performanceStreamEnd}`

export const performanceStreamOptions = { reply: performanceStreamReply, chunkSize: 24, delayMs: 12 }
export const performanceStreamMetadata = {
  name: 'long-markdown-v1',
  characters: performanceStreamReply.length,
  sections: performanceStreamSections,
  chunkSize: performanceStreamOptions.chunkSize,
  delayMs: performanceStreamOptions.delayMs,
  chunks: Math.ceil(performanceStreamReply.length / performanceStreamOptions.chunkSize),
}
