/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { buildProjectPromptSection, selectWithinBudget } from './project-prompt'

const doc = (filename: string, content: string) => ({ filename, content })

describe('buildProjectPromptSection', () => {
  it('returns null with no project', () => {
    expect(buildProjectPromptSection(null)).toBeNull()
  })

  it('returns null when the project contributes nothing', () => {
    expect(buildProjectPromptSection({ name: 'Empty', instructions: null, knowledge: [] })).toBeNull()
    expect(buildProjectPromptSection({ name: 'Blank', instructions: '   ', knowledge: [] })).toBeNull()
  })

  it('renders the project name and instructions', () => {
    const section = buildProjectPromptSection({
      name: 'Q3 Planning',
      instructions: 'Always answer in bullet points.',
      knowledge: [],
    })
    expect(section).toContain('# Project: Q3 Planning')
    expect(section).toContain('Always answer in bullet points.')
  })

  it('wraps each knowledge document in a delimited block', () => {
    const section = buildProjectPromptSection({
      name: 'P',
      instructions: null,
      knowledge: [doc('policy.md', 'No refunds after 30 days.')],
    })
    expect(section).toContain('<document filename="policy.md">')
    expect(section).toContain('No refunds after 30 days.')
    expect(section).toContain('</document>')
  })

  it('names omitted documents in-prompt rather than dropping them silently', () => {
    const section = buildProjectPromptSection(
      {
        name: 'P',
        instructions: null,
        knowledge: [doc('small.md', 'tiny'), doc('huge.md', 'x '.repeat(20_000))],
      },
      { knowledgeTokenBudget: 100 },
    )
    expect(section).toContain('small.md')
    expect(section).toContain('did not fit in context')
    expect(section).toContain('huge.md')
    expect(section).not.toContain('x x x')
  })

  it('omits the empty-knowledge heading when nothing was dropped', () => {
    const section = buildProjectPromptSection({ name: 'P', instructions: 'Be terse.', knowledge: [] })
    expect(section).not.toContain('Project knowledge')
  })
})

describe('selectWithinBudget', () => {
  it('takes documents in order while they fit', () => {
    const { included, omitted } = selectWithinBudget([doc('a', 'aa'), doc('b', 'bb'), doc('c', 'cc')], 10_000)
    expect(included.map((d) => d.filename)).toEqual(['a', 'b', 'c'])
    expect(omitted).toEqual([])
  })

  it('never includes a partial document', () => {
    const big = doc('big.md', 'word '.repeat(5_000))
    const { included, omitted } = selectWithinBudget([big], 50)
    expect(included).toEqual([])
    expect(omitted).toEqual(['big.md'])
  })

  it('keeps later small documents when an earlier one is too big', () => {
    const { included, omitted } = selectWithinBudget([doc('big', 'word '.repeat(5_000)), doc('small', 'hi')], 200)
    expect(included.map((d) => d.filename)).toEqual(['small'])
    expect(omitted).toEqual(['big'])
  })
})

describe('advertising the cross-chat search tool', () => {
  it('names the tool so the model knows to reach for it', () => {
    const section = buildProjectPromptSection(
      { name: 'P', instructions: 'Be terse.', knowledge: [] },
      { hasSearchableChats: true },
    )
    expect(section).toContain('search_project_chats')
    // The lexical caveat travels with the tool mention, not just the tool schema.
    expect(section).toContain('keyword search')
  })

  it('says nothing about other chats when the tool is not registered', () => {
    const section = buildProjectPromptSection({ name: 'P', instructions: 'Be terse.', knowledge: [] })
    expect(section).not.toContain('search_project_chats')
  })

  it('still renders a section for a bare project that only has other chats', () => {
    const section = buildProjectPromptSection(
      { name: 'P', instructions: null, knowledge: [] },
      { hasSearchableChats: true },
    )
    expect(section).toContain('# Project: P')
  })
})

describe('assistant memory guidance', () => {
  it('tells the model how to use the note tool when enabled', () => {
    const section = buildProjectPromptSection({ name: 'P', instructions: null, knowledge: [] }, { notes: 'enabled' })
    expect(section).toContain('save_project_note')
    expect(section).toContain('durable')
    // Guardrail carried in the prompt, not just the tool description.
    expect(section).toContain('private')
  })

  it('does not offer the tool when the project has not opted in', () => {
    const section = buildProjectPromptSection({ name: 'P', instructions: 'Be terse.', knowledge: [] })
    expect(section).not.toContain('save_project_note')
  })

  it('still explains notes when they are off, so the model can flag a missed one', () => {
    const section = buildProjectPromptSection({ name: 'P', instructions: null, knowledge: [] }, { notes: 'disabled' })
    expect(section).toContain('currently off')
    expect(section).toContain('assistant memory is off')
    // Must not dangle a tool it cannot call.
    expect(section).not.toContain('`save_project_note` tool')
  })

  it('never claims it will remember when notes are off', () => {
    const section = buildProjectPromptSection({ name: 'P', instructions: null, knowledge: [] }, { notes: 'disabled' })
    expect(section).toContain('will not remember')
    expect(section).toContain('at most once')
  })

  it('blames the model, not the setting, when notes are on but tools are unavailable', () => {
    const section = buildProjectPromptSection(
      { name: 'P', instructions: null, knowledge: [] },
      { notes: 'unsupported' },
    )
    expect(section).toContain('cannot use tools')
    // The regression this state exists for: never tell the user to switch on
    // something they already switched on.
    expect(section).toContain('already on')
    expect(section).not.toContain('has not enabled')
  })

  it('does not mention the disabled state when notes are enabled', () => {
    const section = buildProjectPromptSection({ name: 'P', instructions: null, knowledge: [] }, { notes: 'enabled' })
    expect(section).not.toContain('currently off')
  })
})
