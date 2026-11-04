/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createCloudAgentClient, type CloudArtifactView } from '@/cloud-agent/client'
import { createCloudOfflineStore } from '@/cloud-agent/offline'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { HttpClient } from '@/lib/http'

export type SnapshotArtifactView = CloudArtifactView
export type ArtifactClient = Pick<
  ReturnType<typeof createCloudAgentClient>,
  | 'artifacts'
  | 'getArtifact'
  | 'artifactContent'
  | 'prepareArtifact'
  | 'submitArtifact'
  | 'artifactGrants'
  | 'grantArtifact'
  | 'revokeArtifact'
  | 'agents'
>

/** Artifact scopes and cached ciphertext belong to the owner, independently of an executing agent. */
export const createArtifactClient = (http: HttpClient, ownerId: string, db: AnyDrizzleDatabase): ArtifactClient =>
  createCloudAgentClient(http, ownerId, createCloudOfflineStore(db, ownerId))
