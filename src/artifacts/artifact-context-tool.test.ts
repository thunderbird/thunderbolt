/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useArtifactContextStore } from './artifact-context-store'
import { createArtifactContextTool, formatArtifactContext } from './artifact-context-tool'

const context = { title: 'Q3 Revenue', summary: 'EMEA 4.2M · APAC 1.98M' }

/*
 * The store is a module-level singleton shared by every test file in the
 * process. Left open, the last test here would hand a stale `title` to
 * `src/ai/fetch.ts`, which registers `get_app_context` on the strength of it —
 * so an ordinary chat in a later file would carry a tool describing an artifact
 * nobody has open. Reset on both edges, because this file cannot control what
 * ran before it either.
 */
beforeEach(() => useArtifactContextStore.getState().closeArtifact())
afterEach(() => useArtifactContextStore.getState().closeArtifact())

const run = async () => {
  const tool = createArtifactContextTool({
    getSnapshot: () => {
      const { title, context: current } = useArtifactContextStore.getState()
      return { title, context: current }
    },
  })
  // The AI SDK's execute signature takes args and call options; neither is read.
  return (await tool.execute?.({}, { toolCallId: 't', messages: [] })) as string
}

describe('formatArtifactContext', () => {
  it('leads with what the page currently shows', () => {
    const text = formatArtifactContext('Q3 Revenue', context)
    expect(text).toContain('Q3 Revenue')
    expect(text).toContain('EMEA 4.2M')
  })

  /**
   * The failure this guards is the model answering confidently from the HTML it
   * wrote, which describes the page as authored rather than as it now stands.
   */
  it('tells the model to admit it cannot see, rather than guess from the source', () => {
    const text = formatArtifactContext('Q3 Revenue', null)
    expect(text).toContain("hasn't reported")
    expect(text.toLowerCase()).toContain('rather than guessing')
  })
})

describe('get_app_context for artifacts', () => {
  it('reports nothing open when no panel is up', async () => {
    useArtifactContextStore.getState().closeArtifact()
    expect(await run()).toBe('No artifact is open.')
  })

  it('describes the open artifact once it has reported', async () => {
    useArtifactContextStore.getState().openArtifact('Q3 Revenue')
    useArtifactContextStore.getState().setContext(context)
    expect(await run()).toContain('EMEA 4.2M')
  })

  /** A context outliving its panel would describe a surface the user closed. */
  it('stops describing an artifact after its panel closes', async () => {
    useArtifactContextStore.getState().openArtifact('Q3 Revenue')
    useArtifactContextStore.getState().setContext(context)
    useArtifactContextStore.getState().closeArtifact()
    expect(await run()).toBe('No artifact is open.')
  })

  /** Opening a second artifact must not inherit the first one's description. */
  it('does not carry context across from a previous artifact', async () => {
    useArtifactContextStore.getState().openArtifact('Q3 Revenue')
    useArtifactContextStore.getState().setContext(context)
    useArtifactContextStore.getState().openArtifact('Headcount Plan')

    const text = await run()
    expect(text).toContain('Headcount Plan')
    expect(text).not.toContain('EMEA 4.2M')
  })
})
