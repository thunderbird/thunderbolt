/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDeviceById, isTrustedAppDevice } from '@/dal/devices'
import type { QueryableDatabase } from '@/db/client'
import { CloudError } from './errors'

/** Match a client claim to the server-bound session before checking device trust or granting cloud capabilities. */
export const requireCloudTrustedDevice = async (
  database: QueryableDatabase,
  ownerId: string,
  request: Request,
  session: { deviceId?: string | null },
): Promise<string> => {
  const deviceId = request.headers.get('x-device-id')?.trim()
  if (!deviceId || !session.deviceId || deviceId !== session.deviceId) {
    throw new CloudError(403, 'cloud_trusted_device_required')
  }
  const device = await getDeviceById(database, deviceId)
  if (!isTrustedAppDevice(device, ownerId) || device?.revokedAt != null) {
    throw new CloudError(403, 'cloud_trusted_device_required')
  }
  return deviceId
}
