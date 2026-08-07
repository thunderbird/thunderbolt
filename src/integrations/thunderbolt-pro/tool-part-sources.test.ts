/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { SourceMetadata } from '@shared/tools/pro-tools-contract'
import type { UIMessage } from 'ai'
import { deriveSourcesFromToolParts } from './tool-part-sources'

type Part = UIMessage['parts'][number]

const source = (index: number, overrides: Partial<SourceMetadata> = {}): SourceMetadata => ({
  index,
  url: `https://site-${index}.test/`,
  title: `Site ${index}`,
  author: null,
  publishedDate: null,
  toolName: 'search',
  ...overrides,
})

const toolPart = (toolName: string, sources: SourceMetadata[] | undefined, state: string = 'output-available'): Part =>
  ({
    type: `tool-${toolName}`,
    toolCallId: `call-${toolName}-${Math.random()}`,
    state,
    input: {},
    output: sources ? { content: [], details: {}, sources } : { content: [], details: {} },
  }) as unknown as Part

const textPart = (text: string): Part => ({ type: 'text', text }) as Part

describe('deriveSourcesFromToolParts', () => {
  it('collects sources from search and fetch_content tool parts, sorted by index', () => {
    const parts = [
      textPart('answer [1][2]'),
      toolPart('search', [source(2), source(1)]),
      toolPart('fetch_content', [source(3, { toolName: 'fetch_content' })]),
    ]
    expect(deriveSourcesFromToolParts(parts)?.map((entry) => entry.index)).toEqual([1, 2, 3])
  })

  it('returns undefined when no runner tool part carries sources (local turns)', () => {
    const localOutputPart = {
      type: 'tool-search',
      toolCallId: 'call-local',
      state: 'output-available',
      input: {},
      // Local execution returns the raw results array — no `sources` field.
      output: [{ sourceLabel: '[Source 1] (cite as [1])', pageUrl: 'https://a.test/' }],
    } as unknown as Part
    expect(deriveSourcesFromToolParts([textPart('hi'), localOutputPart])).toBeUndefined()
  })

  it('ignores unfinished tool parts and unrelated tools', () => {
    const parts = [
      toolPart('search', [source(1)], 'input-available'),
      toolPart('render_html', [source(9, { toolName: 'fetch_content' })]),
    ]
    expect(deriveSourcesFromToolParts(parts)).toBeUndefined()
  })

  it('merges duplicate indexes with later defined fields winning (fetch_content is authoritative)', () => {
    const fromSearch = source(1, { title: 'Search title', siteName: 'a.test' })
    const fromFetch = source(1, {
      toolName: 'fetch_content',
      title: 'Real page title',
      description: 'snippet',
      siteName: '',
    })
    const merged = deriveSourcesFromToolParts([
      toolPart('search', [fromSearch]),
      toolPart('fetch_content', [fromFetch]),
    ])
    expect(merged).toEqual([
      {
        index: 1,
        url: 'https://site-1.test/',
        title: 'Real page title',
        description: 'snippet',
        image: undefined,
        favicon: undefined,
        siteName: 'a.test',
        author: null,
        publishedDate: null,
        toolName: 'fetch_content',
      },
    ])
  })

  it('tolerates a null tool output', () => {
    const nullOutputPart = {
      type: 'tool-fetch_content',
      toolCallId: 'call-null',
      state: 'output-available',
      input: {},
      output: null,
    } as unknown as Part
    expect(deriveSourcesFromToolParts([nullOutputPart])).toBeUndefined()
  })
})
