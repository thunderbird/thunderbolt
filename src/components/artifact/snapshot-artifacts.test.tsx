/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { afterAll, afterEach, beforeAll, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useQuery } from '@tanstack/react-query'
import { createTestProvider } from '@/test-utils/test-provider'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import type { ArtifactClient, SnapshotArtifactView } from '@/artifacts/client'
import type { ScopedCiphertext } from '@shared/cloud-agent/crypto'
import { SnapshotArtifactDetails } from './snapshot-artifacts'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(cleanup)

const ciphertext: ScopedCiphertext = { version: 1, kind: 'scoped-payload', iv: 'iv', ciphertext: 'encrypted' }
const initial: SnapshotArtifactView = {
  artifact: {
    id: 'artifact',
    ownerId: 'owner',
    currentRevisionId: 'first',
    keyEpoch: 1,
    createdAt: '2026-10-23T12:00:00Z',
    deletedAt: null,
    ownerKeyEnvelope: {
      version: 1,
      kind: 'resource-key',
      recipientKeyId: 'owner',
      ephemeralPublicKey: 'ec',
      mlkemCiphertext: 'pq',
      iv: 'iv',
      ciphertext: 'key',
    },
  },
  revisions: [
    {
      record: {
        id: 'first',
        artifactId: 'artifact',
        parentRevisionId: null,
        keyEpoch: 1,
        manifest: ciphertext,
        byteLength: 3,
        conflict: false,
        createdAt: '2026-10-23T12:00:00Z',
      },
      manifest: {
        title: 'Test document',
        mediaType: 'text/plain',
        files: [{ path: 'note.txt', mediaType: 'text/plain', size: 3 }],
      },
    },
  ],
}
const unexpected = async (): Promise<never> => {
  throw new Error('Unexpected artifact API call')
}

it('refreshes the library and selected content after saving a snapshot revision', async () => {
  const revisionId = crypto.randomUUID()
  const state = { artifact: initial, content: 'old', listReads: 0, savedParent: '' }
  const client: ArtifactClient = {
    artifacts: unexpected,
    getArtifact: unexpected,
    agents: async () => [],
    artifactGrants: async () => [],
    grantArtifact: unexpected,
    revokeArtifact: unexpected,
    artifactContent: async (_artifact, revisionId) => ({
      files: [{ path: 'note.txt', mediaType: 'text/plain', content: revisionId === 'first' ? 'old' : state.content }],
    }),
    prepareArtifact: async (artifact, parentRevisionId, _title, files) => {
      state.content = files[0].content
      return {
        artifactId: artifact.id,
        body: { id: revisionId, parentRevisionId, keyEpoch: 1, manifest: ciphertext, content: ciphertext },
      }
    },
    submitArtifact: async (input) => {
      state.savedParent = input.body.parentRevisionId
      const record = {
        ...initial.revisions[0].record,
        id: revisionId,
        parentRevisionId: 'first',
        createdAt: '2026-10-23T12:01:00Z',
      }
      state.artifact = {
        artifact: { ...initial.artifact, currentRevisionId: revisionId },
        revisions: [{ record, manifest: initial.revisions[0].manifest }, ...initial.revisions],
      }
      return record
    },
  }
  const Harness = () => {
    const list = useQuery({
      queryKey: ['artifacts', 'owner', 'list'],
      queryFn: async () => {
        state.listReads += 1
        return [state.artifact]
      },
    })
    return list.data ? (
      <SnapshotArtifactDetails client={client} artifact={list.data[0]} ownerId="owner" onBack={() => {}} />
    ) : null
  }
  const Provider = createTestProvider()
  render(
    <Provider>
      <Harness />
    </Provider>,
  )
  await waitForElement(() => screen.queryByRole('button', { name: 'Edit files' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit files' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'File contents' }), { target: { value: 'new content' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }))
  await waitForElement(() => screen.queryByText('new content', { selector: 'pre' }))
  expect(screen.getByText('new content', { selector: 'pre' })).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'File contents' })).toBeNull()
  expect(state.savedParent).toBe('first')
  expect(state.listReads).toBeGreaterThan(1)
})
