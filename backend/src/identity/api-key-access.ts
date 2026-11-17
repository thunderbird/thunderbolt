/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultKeyHasher } from '@better-auth/api-key'
import type { GenericEndpointContext } from 'better-auth'
import { getAccess } from './access'

/**
 * The api-key plugin's `customAPIKeyValidator`: refuse a key whose owner has no access. It runs
 * in the plugin's before-hook on every request carrying `x-api-key`, ahead of the session the
 * plugin builds, which on `/get-session` is returned before any after-hook could check it.
 *
 * An unknown key passes, so the plugin rejects it with its usual error. Anonymous owners pass:
 * they are not members.
 */
export const apiKeyOwnerHasAccess = async ({ ctx, key }: { ctx: GenericEndpointContext; key: string }) => {
  const adapter = ctx.context.adapter
  const apiKey = await adapter.findOne<{ referenceId: string }>({
    model: 'apikey',
    where: [{ field: 'key', value: await defaultKeyHasher(key) }],
  })
  if (!apiKey) {
    return true
  }
  const owner = await adapter.findOne<{ id: string; isAnonymous: boolean | null }>({
    model: 'user',
    where: [{ field: 'id', value: apiKey.referenceId }],
  })
  if (!owner || owner.isAnonymous) {
    return true
  }
  return (await getAccess(adapter, owner.id)).allowed
}
