/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { ThunderboltUIMessage } from '@/types'
import type { ToolCallOptions } from 'ai'
import {
  createLoadToolsTool,
  loadedToolNamesFromCalls,
  loadedToolNamesFromHistory,
  resolveToolNames,
  selectActiveToolNames,
} from './load-tools-tool'

const connectionToolNames = new Set(['notion_search', 'notion_fetch', 'linear_list_issues'])
const toolCallOptions: ToolCallOptions = { toolCallId: 'load-call', messages: [] }

/** An assistant message holding one `load_tools` part in the given state. */
const loadMessage = (names: unknown, state = 'output-available'): ThunderboltUIMessage =>
  ({
    id: `a-${JSON.stringify(names)}-${state}`,
    role: 'assistant',
    parts: [{ type: 'tool-load_tools', toolCallId: 'call', state, input: { names } }],
  }) as ThunderboltUIMessage

describe('resolveToolNames', () => {
  it('splits known and unknown names and drops duplicates', () => {
    expect(resolveToolNames(['notion_search', 'nope', 'notion_search', 'nope'], connectionToolNames)).toEqual({
      loaded: ['notion_search'],
      notFound: ['nope'],
    })
  })

  it('ignores non-string entries', () => {
    expect(resolveToolNames([42, null, 'notion_fetch'], connectionToolNames)).toEqual({
      loaded: ['notion_fetch'],
      notFound: [],
    })
  })
})

describe('createLoadToolsTool', () => {
  it('returns the loaded names and the unknown ones', async () => {
    const loadTools = createLoadToolsTool(connectionToolNames)

    expect(await loadTools.execute?.({ names: ['notion_fetch', 'nope'] }, toolCallOptions)).toEqual({
      loaded: ['notion_fetch'],
      notFound: ['nope'],
    })
  })

  it('throws when no name matches', async () => {
    const loadTools = createLoadToolsTool(connectionToolNames)

    expect(loadTools.execute?.({ names: ['nope'] }, toolCallOptions)).rejects.toThrow('No connection tools match: nope')
  })

  it('reads the connection set at call time', async () => {
    const names = new Set<string>()
    const loadTools = createLoadToolsTool(names)
    names.add('late_tool')

    expect(await loadTools.execute?.({ names: ['late_tool'] }, toolCallOptions)).toEqual({
      loaded: ['late_tool'],
      notFound: [],
    })
  })
})

describe('loadedToolNamesFromHistory', () => {
  it('collects names from finished load_tools calls across turns', () => {
    const messages = [loadMessage(['notion_search']), loadMessage(['linear_list_issues', 'notion_search'])]

    expect(loadedToolNamesFromHistory(messages, connectionToolNames)).toEqual(['notion_search', 'linear_list_issues'])
  })

  it('ignores errored or unfinished calls and malformed input', () => {
    const messages = [
      loadMessage(['notion_search'], 'output-error'),
      loadMessage(['notion_fetch'], 'input-available'),
      loadMessage('notion_search'),
    ]

    expect(loadedToolNamesFromHistory(messages, connectionToolNames)).toEqual([])
  })

  it('drops tools whose connection is gone', () => {
    expect(loadedToolNamesFromHistory([loadMessage(['github_search'])], connectionToolNames)).toEqual([])
  })
})

describe('loadedToolNamesFromCalls', () => {
  it('reads only load_tools calls', () => {
    const calls = [
      { toolName: 'search', input: { names: ['notion_search'] } },
      { toolName: 'load_tools', input: { names: ['notion_fetch', 'nope'] } },
    ]

    expect(loadedToolNamesFromCalls(calls, connectionToolNames)).toEqual(['notion_fetch'])
  })
})

describe('selectActiveToolNames', () => {
  it('keeps every non-connection tool and only the loaded connection tools', () => {
    const all = ['search', 'load_tools', 'notion_search', 'notion_fetch', 'linear_list_issues']

    expect(selectActiveToolNames(all, connectionToolNames, ['notion_fetch'])).toEqual([
      'search',
      'load_tools',
      'notion_fetch',
    ])
  })
})
