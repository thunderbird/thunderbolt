/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CloudConnectionView } from './client'

/** Opaque records let library tests exercise binding rules without granting a real credential. */
export const connectionFixture = (libraryId?: string): CloudConnectionView => ({
  record: {
    id: 'cloud-connection',
    ownerId: 'owner',
    version: 1,
    keyEpoch: 1,
    enabled: true,
    status: 'ready',
    updatedAt: '2026-10-23T00:00:00Z',
    deletedAt: null,
    config: { version: 1, kind: 'scoped-payload', iv: 'encrypted', ciphertext: 'encrypted' },
    ownerKeyEnvelope: {
      version: 1,
      kind: 'resource-key',
      recipientKeyId: 'owner',
      ephemeralPublicKey: 'encrypted',
      mlkemCiphertext: 'encrypted',
      iv: 'encrypted',
      ciphertext: 'encrypted',
    },
  },
  config: {
    name: 'Tools',
    kind: 'mcp',
    url: 'https://tools.example.com/mcp',
    authentication: { type: 'bearer', token: 'cloud-only-secret' },
    ...(libraryId ? { libraryRef: { kind: 'mcp', id: libraryId } } : {}),
  },
})
