/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash } from 'crypto'

/** Client id of the deployment that hosts the intake (Thunderbolt itself). */
export const selfDebugTranscriptClientId = 'self'

/** Lowercase hex SHA-256 of a client key; only the hash is stored. */
export const hashDebugTranscriptClientKey = (key: string): string => createHash('sha256').update(key).digest('hex')
