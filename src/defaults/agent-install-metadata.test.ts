/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { agentRegistrySnapshot } from './agent-registry'
import { agentInstallMetadata } from './agent-install-metadata'

describe('agentInstallMetadata', () => {
  const snapshotIds = new Set(agentRegistrySnapshot.map((entry) => entry.id))

  it('keys only ids that exist in the registry snapshot', () => {
    for (const id of Object.keys(agentInstallMetadata)) {
      expect(snapshotIds.has(id)).toBe(true)
    }
  })

  it('gives every required env var a non-empty name and description', () => {
    for (const meta of Object.values(agentInstallMetadata)) {
      for (const env of meta.requiredEnv ?? []) {
        expect(env.name.length).toBeGreaterThan(0)
        expect(env.description.length).toBeGreaterThan(0)
      }
    }
  })

  it('uses https docs URLs where authored', () => {
    for (const meta of Object.values(agentInstallMetadata)) {
      if (meta.docsUrl) {
        expect(meta.docsUrl).toMatch(/^https:\/\//)
      }
    }
  })

  it('gives every binary-only agent an authored run command', () => {
    const binaryOnlyAgents = agentRegistrySnapshot.filter(
      (entry) => entry.distribution.binary && !entry.distribution.npx && !entry.distribution.uvx,
    )

    for (const entry of binaryOnlyAgents) {
      expect(agentInstallMetadata[entry.id]?.runCommand).toBeTruthy()
    }
  })
})
