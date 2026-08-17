/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { buildProjectPromptSection } from './project-prompt'

describe('buildProjectPromptSection', () => {
  it('returns null with no project', () => {
    expect(buildProjectPromptSection(null)).toBeNull()
  })

  it('returns null when the project contributes nothing', () => {
    // No empty `# Project` heading: it would spend prompt on nothing and read as
    // though context were provided.
    expect(buildProjectPromptSection({ name: 'Empty', instructions: null })).toBeNull()
    expect(buildProjectPromptSection({ name: 'Blank', instructions: '   ' })).toBeNull()
  })

  it('renders the project name and instructions', () => {
    const section = buildProjectPromptSection({
      name: 'Q3 Planning',
      instructions: 'Always answer in bullet points.',
    })
    expect(section).toContain('# Project: Q3 Planning')
    expect(section).toContain('Always answer in bullet points.')
  })

  it('says the instructions apply to the whole conversation', () => {
    const section = buildProjectPromptSection({ name: 'P', instructions: 'Be terse.' })
    expect(section).toContain('every message in this conversation')
  })

  it('trims instructions rather than emitting the whitespace', () => {
    const section = buildProjectPromptSection({ name: 'P', instructions: '  Be terse.  ' })
    expect(section).toContain('## Project instructions\nBe terse.')
  })
})

describe('advertising the cross-chat search tool', () => {
  it('names the tool so the model knows to reach for it', () => {
    const section = buildProjectPromptSection({ name: 'P', instructions: 'Be terse.' }, { hasSearchableChats: true })
    // Without this the model reads its project context, sees no mention of other
    // conversations, and says "I can't see your other chats" without ever calling
    // the tool that is sitting right there.
    expect(section).toContain('search_project_chats')
  })

  it('warns that the search is lexical, so a miss is retried with synonyms', () => {
    const section = buildProjectPromptSection({ name: 'P', instructions: null }, { hasSearchableChats: true })
    expect(section).toContain('keyword search')
  })

  it('renders a section for a project with only searchable chats', () => {
    // Instructions are empty, but there is still something to say.
    const section = buildProjectPromptSection({ name: 'P', instructions: null }, { hasSearchableChats: true })
    expect(section).toContain('# Project: P')
    expect(section).not.toContain('## Project instructions')
  })

  it('stays silent about the tool when it was not registered', () => {
    const section = buildProjectPromptSection({ name: 'P', instructions: 'Be terse.' })
    expect(section).not.toContain('search_project_chats')
  })
})
