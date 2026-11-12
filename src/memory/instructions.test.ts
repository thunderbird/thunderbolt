/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { buildMemoryInstructions } from './instructions'

describe('memory instructions', () => {
  it('requires exact read-before-write replacement and preservation of unrelated facts', () => {
    const instructions = buildMemoryInstructions(['read_memory', 'save_memory'])
    expect(instructions).toContain('expectedRevision')
    expect(instructions).toContain('Do not reproduce the old document')
    expect(instructions).not.toContain('expectedContent')
    expect(instructions).toContain('preserving unrelated facts')
    expect(instructions).toContain('save empty content')
    expect(instructions).not.toContain('forget_memory')
  })

  it('forbids persistence claims and tool bypasses when saved-memory tools are unavailable', () => {
    const instructions = buildMemoryInstructions(['search_sessions', 'read_session'])
    expect(instructions).toContain('Do not claim to save, update, or forget')
    expect(instructions).toContain('do not use other tools to bypass')
    expect(instructions).toContain('## Earlier chats')
    expect(instructions).toContain('context already supplied')
  })

  it('removes superseded values instead of preserving them as correction history', () => {
    const instructions = buildMemoryInstructions(['read_memory', 'save_memory'])
    expect(instructions).toContain('store only the current fact')
    expect(instructions).toContain('Remove the superseded value completely')
    expect(instructions).toContain('do not retain a change history with "previously", "used to", or "changed from"')
    expect(instructions).toContain('replace "Prefers coffee." with "Prefers tea."')
    expect(instructions).toContain('Preserve unrelated facts.')
  })

  it('permits selected external memory capabilities without inventing the built-in document workflow', () => {
    const instructions = buildMemoryInstructions(
      ['work_notes_search', 'work_notes_add'],
      ['work_notes_search', 'work_notes_add'],
    )
    expect(instructions).toContain("Your selected memory provider's tools are available")
    expect(instructions).toContain("Use the provider's own input schemas")
    expect(instructions).toContain('Claim a change only after the corresponding tool succeeds')
    expect(instructions).toContain('do not copy memory to another store')
    expect(instructions).not.toContain('expectedRevision')
    expect(instructions).not.toContain('Saved-memory tools are unavailable')
  })

  it('does not infer memory authorization from names or stale provider metadata', () => {
    for (const selected of [[], ['disconnected_memory_search']]) {
      const instructions = buildMemoryInstructions(['memory_search', 'memory_save'], selected)
      expect(instructions).toContain('Saved-memory tools are unavailable')
      expect(instructions).not.toContain("Your selected memory provider's tools are available")
    }
  })
})
