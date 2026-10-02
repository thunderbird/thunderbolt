/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The two ends of the wire agree on a version number.
 *
 * This reads both literals off disk instead of importing them, which is
 * deliberate: `miniapps/` is a separate bun workspace whose SDK is meant to be
 * droppable into a customer's app with no dependency on this repo at all, so
 * there is no module either side can import. Text is the only link available,
 * and having one is the point — bumping `miniAppProtocolVersion` without
 * bumping the guest declares an unsupported version and the host rejects every
 * handshake. Nothing else catches it: `use-mini-app-bridge.test.tsx` builds its
 * handshake from the host's own constant, so both sides move together there and
 * the suite stays green while no real guest can connect.
 */

import { describe, expect, it } from 'bun:test'
import { supportedProtocolVersions } from '@shared/mini-app-protocol'

const readDeclaredVersion = async (path: string): Promise<number> => {
  const source = await Bun.file(new URL(path, import.meta.url)).text()
  const match = source.match(/^const protocolVersion = (\d+)$/m)
  if (!match) {
    throw new Error(`no top-level \`const protocolVersion = <n>\` found in ${path}`)
  }
  return Number(match[1])
}

describe('protocol version', () => {
  it('is one the host still speaks, as declared by the SDK guests use', async () => {
    const declared = await readDeclaredVersion('../../miniapps/sdk/src/bridge.ts')
    expect([...supportedProtocolVersions]).toContain(declared)
  })
})
