/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { artifactLocation, artifactSelection, messageArtifacts } from './library'

const htmlPart = (output: unknown = { ok: true }, title = 'Report') => ({
  type: 'tool-render_html',
  toolCallId: crypto.randomUUID(),
  state: 'output-available',
  input: { html: '<h1>Saved work</h1>', title },
  output,
})

describe('artifact library', () => {
  it('indexes verified local and ACP message artifacts, preserves distinct part identities', () => {
    const id = uuidv7()
    const artifacts = messageArtifacts([
      {
        id,
        chatThreadId: 'chat',
        chatTitle: 'A chat',
        parts: JSON.stringify([
          { type: 'text', text: 'Intro' },
          htmlPart({ ok: false, errors: ['invalid'] }),
          htmlPart(),
          { ...htmlPart({ details: { ok: true } }), type: 'dynamic-tool', toolName: 'render_html' },
        ]),
      },
    ])
    expect(artifacts.map((artifact) => artifact.id)).toEqual([`${id}-1`, `${id}-2`])
    expect(artifacts.map((artifact) => artifact.html)).toEqual(['<h1>Saved work</h1>', '<h1>Saved work</h1>'])
    expect(artifacts.every((artifact) => artifact.chatThreadId === 'chat')).toBe(true)
  })

  it('does not promote streaming, failed, blank or malformed message parts into the library', () => {
    const base = { id: uuidv7(), chatThreadId: 'chat', chatTitle: null }
    expect(
      messageArtifacts([
        {
          ...base,
          parts: [
            { ...htmlPart(), state: 'input-streaming' },
            htmlPart({ ok: false, errors: [] }),
            { ...htmlPart(), input: { html: ' ' } },
          ],
        },
        { ...base, parts: '{broken' },
        { ...base, parts: null },
        { ...base, chatThreadId: null, parts: [htmlPart()] },
      ]),
    ).toEqual([])
  })

  it('round-trips standalone deep links without an agent ID', () => {
    for (const selection of [
      { kind: 'snapshot' as const, id: 'saved/id' },
      { kind: 'message' as const, id: 'message-1' },
    ]) {
      const location = artifactLocation(selection)
      expect(artifactSelection(new URL(location, 'https://example.test').searchParams)).toEqual(selection)
      expect(location.startsWith('/artifacts?')).toBe(true)
    }
    expect(artifactLocation()).toBe('/artifacts')
    expect(artifactSelection(new URLSearchParams())).toBeNull()
  })
})
