/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getProviderDefinition } from '@/providers/registry'
import type { ProviderConnection } from '@/providers/types'

/** Search eligibility depends on the reusable connection, independently of its models. */
export const canSupplySearch = (connection: ProviderConnection): boolean =>
  Boolean(connection.enabled && connection.connected && !connection.deletedAt) &&
  getProviderDefinition(connection.provider).capabilities.includes('search')
