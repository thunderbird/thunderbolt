/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { UIMessage } from 'ai'
import { resolveMiniAppIcon } from '@/mini-apps/registry'
import {
  artifactId,
  artifactPath,
  parseArtifactId,
  toHtmlArtifact,
  toRemoteArtifact,
  type ArtifactReference,
} from './artifact'

const verifiedPart: UIMessage['parts'][number] = {
  type: 'dynamic-tool',
  toolName: 'render_html',
  toolCallId: 'call-1',
  state: 'output-available',
  input: { title: '  Dashboard  ', html: '<h1>Sales</h1>' },
  output: { ok: true },
}

describe('artifact identity', () => {
  it.each<ArtifactReference>([
    { kind: 'html', messageId: 'message-1', toolCallId: 'call-1' },
    { kind: 'html', messageId: 'a:b/c?%#', toolCallId: '日本語 /?&' },
    { kind: 'remote', appId: 'a:b/c?%#' },
  ])('round-trips source references without route delimiters colliding: %j', (reference) => {
    const id = artifactId(reference)
    expect(parseArtifactId(id)).toEqual(reference)
    const path = artifactPath(id)
    expect(path.split('/')).toHaveLength(3)
    expect(decodeURIComponent(path.slice('/artifacts/'.length))).toBe(id)
  })

  it('separates messages, calls, and remote apps even if their constituent IDs match', () => {
    const references: ArtifactReference[] = [
      { kind: 'html', messageId: 'a:b', toolCallId: 'c' },
      { kind: 'html', messageId: 'a', toolCallId: 'b:c' },
      { kind: 'html', messageId: 'a', toolCallId: 'c' },
      { kind: 'html', messageId: 'b', toolCallId: 'c' },
      { kind: 'remote', appId: 'a:c' },
    ]
    expect(new Set(references.map(artifactId)).size).toBe(references.length)
  })

  it.each([
    '',
    'unknown:a',
    'remote:',
    'remote:a:b',
    'html:a',
    'html:a:',
    'html::b',
    'html:a:b:c',
    'html:%:b',
    'remote:%ZZ',
    'remote:%61',
    'remote:_w',
    'remote:YQ==',
    'remote:YR',
  ])('rejects malformed or noncanonical identity %s', (id) => {
    expect(parseArtifactId(id)).toBeNull()
  })
})

describe('artifact source adapters', () => {
  it('keeps exact HTML, trimmed title, source chat, and stable identity', () => {
    const artifact = toHtmlArtifact('message-1', 'chat-1', verifiedPart)
    expect(artifact).toEqual({
      id: artifactId({ kind: 'html', messageId: 'message-1', toolCallId: 'call-1' }),
      reference: { kind: 'html', messageId: 'message-1', toolCallId: 'call-1' },
      title: 'Dashboard',
      chatThreadId: 'chat-1',
      source: { kind: 'html', html: '<h1>Sales</h1>' },
    })
  })

  it('accepts typed built-in parts and ACP/MCP result envelopes through the existing verdict parser', () => {
    for (const output of [
      { ok: true },
      { details: { ok: true } },
      { content: [{ type: 'text', text: '{"ok":true}' }] },
    ]) {
      const part = { ...verifiedPart, type: 'tool-render_html', output } as UIMessage['parts'][number]
      expect(toHtmlArtifact('message', 'chat', part)?.source.kind).toBe('html')
    }
  })

  it.each([
    { state: 'input-streaming' },
    { state: 'input-available' },
    { state: 'output-error' },
    { output: { ok: false, errors: ['Invalid script'] } },
    { output: { ok: 'true' } },
    { output: undefined },
    { toolName: 'some_other_tool' },
    { toolCallId: '' },
    { input: { html: '   ' } },
    { input: { html: 42 } },
  ])('never promotes an unverified or unusable part: %j', (override) => {
    expect(toHtmlArtifact('message', 'chat', { ...verifiedPart, ...override } as UIMessage['parts'][number])).toBeNull()
  })

  it('rejects a missing message identity and ordinary text', () => {
    expect(toHtmlArtifact('', 'chat', verifiedPart)).toBeNull()
    expect(toHtmlArtifact('message', 'chat', { type: 'text', text: 'render_html' })).toBeNull()
  })

  it('uses translated fallback copy when a valid artifact has no title', () => {
    const part = { ...verifiedPart, input: { html: '<p>Still valid</p>', title: ' ' } } as UIMessage['parts'][number]
    expect(toHtmlArtifact('message', null, part)?.title).toBe('Artifact')
  })

  it('adapts a configured app without copying or changing its security configuration', () => {
    const app = {
      id: 'finance',
      name: 'Finance',
      description: '',
      icon: resolveMiniAppIcon(''),
      url: 'https://finance.example/app',
      origin: 'https://finance.example',
    }
    expect(toRemoteArtifact(app)).toEqual({
      id: artifactId({ kind: 'remote', appId: app.id }),
      reference: { kind: 'remote', appId: app.id },
      title: app.name,
      chatThreadId: null,
      source: { kind: 'remote', app },
    })
  })
})
