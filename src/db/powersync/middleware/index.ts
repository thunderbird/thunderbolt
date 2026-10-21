/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DataTransformMiddleware } from '../sync-transform'
import { encryptionMiddleware } from './EncryptionMiddleware'

/**
 * Every transformer sync data runs through, in order. The single registration point for all
 * sync paths: the sync worker (`ThunderboltSharedSyncImplementation`) and sync in the tab
 * (`ThunderboltPowerSyncDatabase`).
 */
export const syncTransformers: DataTransformMiddleware[] = [encryptionMiddleware]
