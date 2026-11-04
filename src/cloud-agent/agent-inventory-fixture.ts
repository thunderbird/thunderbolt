/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CloudAgentView } from './client'

/** A decrypted test view includes secrets so inventory tests can prove their omission. */
export const cloudAgentViewFixture = (
  ownerId = 'owner',
  id = '00000000-0000-4000-8000-000000000001',
): CloudAgentView => ({
  record: {
    id,
    ownerId,
    version: 1,
    keyEpoch: 1,
    enabled: true,
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:00Z',
    deletedAt: null,
    config: { version: 1, kind: 'scoped-payload', iv: 'secret-iv', ciphertext: 'secret-ciphertext' },
    ownerKeyEnvelope: {
      version: 1,
      kind: 'resource-key',
      recipientKeyId: 'secret-recipient',
      ephemeralPublicKey: 'secret-ephemeral',
      mlkemCiphertext: 'secret-mlkem',
      iv: 'secret-iv',
      ciphertext: 'secret-envelope',
    },
  },
  config: {
    ownerRecipient: { version: 1, keyId: 'secret-owner', ecdhPublicKey: 'secret-ecdh', mlkemPublicKey: 'secret-mlkem' },
    name: 'Cloud assistant',
    description: 'Display description',
    instructions: 'SECRET INSTRUCTIONS',
    model: { provider: 'managed', modelId: 'SECRET MODEL CONFIG', contextWindow: 32000, maxOutputTokens: 1024 },
    skills: [{ name: 'Secret skill', description: '', instruction: 'SECRET SKILL CONTENT' }],
    connectionIds: ['secret-connection'],
    searchEnabled: false,
    approvalMode: 'ask',
    maxSteps: 10,
    maxRunCostUsd: 1,
  },
})
