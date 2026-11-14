/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Realm } from './config'

/** What setup.ts created, for the suites to read. Local test values only; gitignored. */
export type RealmState = {
  identityConnectionId: string
  /** The SCIM token, which Thunderbolt shows only once. */
  scimToken: string
  /** The extension's User Federation component in the realm. */
  targetId: string
}

export type StackState = {
  adminUserId: string
  adminBearer: string
  realms: Record<Realm['name'], RealmState>
}

const statePath = join(import.meta.dir, '..', '.state.json')

export const readState = (): StackState => {
  if (!existsSync(statePath)) {
    throw new Error('No e2e/keycloak/.state.json: run `bun e2e/keycloak/setup.ts` first')
  }
  return JSON.parse(readFileSync(statePath, 'utf8')) as StackState
}

export const readStateIfAny = (): StackState | null => (existsSync(statePath) ? readState() : null)

export const writeState = (state: StackState) => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
