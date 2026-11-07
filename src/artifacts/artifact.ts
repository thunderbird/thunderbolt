/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { UIMessage } from 'ai'
import type { MiniAppDefinition } from '@/mini-apps/registry'
import { decodeBase64Url, encodeBase64Url } from '@shared/base64url'
import { isRenderHtmlPart, renderHtmlInput, renderHtmlOutput } from './render-html-tool'

export type ArtifactReference =
  | { kind: 'html'; messageId: string; toolCallId: string }
  | { kind: 'remote'; appId: string }

export type Artifact = {
  id: string
  legacyIds?: readonly string[]
  reference: ArtifactReference
  title: string
  chatThreadId: string | null
  source: { kind: 'html'; html: string } | { kind: 'remote'; app: MiniAppDefinition }
}

const untitledArtifact = msg`Artifact`

/** Identify a source independently of its title or display mode, without nested URL escapes. */
export const artifactId = (reference: ArtifactReference): string =>
  reference.kind === 'html'
    ? `html:${encodeBase64Url(reference.messageId)}:${encodeBase64Url(reference.toolCallId)}`
    : `remote:${encodeBase64Url(reference.appId)}`

/** Read a canonical artifact identity from a route or persisted pin. */
export const parseArtifactId = (id: string): ArtifactReference | null => {
  const [kind, firstEncoded, secondEncoded, ...rest] = id.split(':')
  if (!firstEncoded || rest.length > 0) {
    return null
  }
  const first = decodeBase64Url(firstEncoded)
  const second = secondEncoded === undefined ? null : decodeBase64Url(secondEncoded)
  if (!first) {
    return null
  }
  const reference: ArtifactReference | null =
    kind === 'html' && second
      ? { kind, messageId: first, toolCallId: second }
      : kind === 'remote' && secondEncoded === undefined
        ? { kind, appId: first }
        : null
  // Round-tripping rejects padding, noncanonical trailing bits, and invalid UTF-8.
  return reference && artifactId(reference) === id ? reference : null
}

/** Open an artifact as a full page without changing whether it is pinned. */
export const artifactPath = (id: string): string => `/artifacts/${encodeURIComponent(id)}`

/** Resolve only completed, verified HTML; all display modes use the same quality gate. */
export const toHtmlArtifact = (
  messageId: string,
  chatThreadId: string | null,
  part: UIMessage['parts'][number],
  legacyIndex?: number,
): Artifact | null => {
  if (
    !messageId ||
    !isRenderHtmlPart(part) ||
    part.state !== 'output-available' ||
    typeof part.toolCallId !== 'string' ||
    !part.toolCallId ||
    renderHtmlOutput(part)?.ok !== true
  ) {
    return null
  }
  const input = renderHtmlInput(part)
  if (!input.html?.trim()) {
    return null
  }
  const reference: ArtifactReference = { kind: 'html', messageId, toolCallId: part.toolCallId }
  return {
    id: artifactId(reference),
    legacyIds: [
      `${messageId}-${part.toolCallId}`,
      ...(legacyIndex === undefined ? [] : [`${messageId}-${legacyIndex}`]),
    ],
    reference,
    title: input.title?.trim() || i18n._(untitledArtifact),
    chatThreadId,
    source: { kind: 'html', html: input.html },
  }
}

/** Adapt an operator-configured app to the same identity and presentation model. */
export const toRemoteArtifact = (app: MiniAppDefinition): Artifact => {
  const reference: ArtifactReference = { kind: 'remote', appId: app.id }
  return { id: artifactId(reference), reference, title: app.name, chatThreadId: null, source: { kind: 'remote', app } }
}
