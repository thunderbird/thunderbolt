/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { acpCompactionSummary } from './compaction-summary'

it('preserves readable ACP resources while omitting embedded binaries and metadata', () => {
  const value = acpCompactionSummary({
    agentId: 'agent',
    sessionId: 's',
    compactionId: 'c',
    status: 'completed',
    _meta: { secret: 'META_SECRET' },
    summary: [
      { type: 'text', text: 'Decisions' },
      { type: 'image', data: 'IMAGE_BYTES', mimeType: 'image/png', uri: 'https://example.invalid/image' },
      { type: 'audio', data: 'AUDIO_BYTES', mimeType: 'audio/wav' },
      {
        type: 'resource_link',
        name: 'fallback',
        title: 'Plan',
        description: 'Project details',
        uri: 'file:///plan.md',
      },
      { type: 'resource_link', name: 'Notes', uri: 'file:///notes.md' },
      {
        type: 'resource',
        resource: { uri: 'file:///readme.md', text: 'Important constraints', mimeType: 'text/plain' },
      },
      {
        type: 'resource',
        resource: { uri: 'file:///blob.bin', blob: 'BLOB_BYTES', mimeType: 'application/octet-stream' },
      },
    ],
  })
  expect(value).toEqual({
    summary: [
      'Decisions',
      'image/png\nhttps://example.invalid/image',
      'audio/wav',
      'Plan\nProject details\nfile:///plan.md',
      'Notes\nfile:///notes.md',
      'file:///readme.md\nImportant constraints',
      'file:///blob.bin\napplication/octet-stream',
    ].join('\n\n'),
  })
  expect(JSON.stringify(value)).not.toMatch(/BYTES|META_SECRET/)
  expect(value).not.toHaveProperty('retainedTail')
})
