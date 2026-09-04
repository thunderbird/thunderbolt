/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isCliDeviceId } from '@/dal/devices'
import { cliRegistrationPendingDeviceId } from '@/dal/sessions'
import { devicesTable } from '@/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import type { InferenceDatabase } from './usage-ledger'

type CliDeviceRequestContext = Readonly<{
  request: Request
  session: { deviceId?: string | null }
  user: { id: string }
}>

/** Reject a marked device-grant session unless it is bound to its active CLI device. */
export const rejectUnregisteredCliDevice = async (
  database: InferenceDatabase,
  registrationEnabled: boolean,
  { request, session, user }: CliDeviceRequestContext,
): Promise<Response | undefined> => {
  if (!registrationEnabled || request.headers.has('x-api-key')) {
    return
  }

  const deviceId = session.deviceId
  if (deviceId !== cliRegistrationPendingDeviceId && (!deviceId || !isCliDeviceId(deviceId))) {
    return
  }

  const activeDevices =
    deviceId === cliRegistrationPendingDeviceId
      ? []
      : await database
          .select({ id: devicesTable.id })
          .from(devicesTable)
          .where(
            and(
              eq(devicesTable.id, deviceId),
              eq(devicesTable.userId, user.id),
              eq(devicesTable.deviceType, 'cli'),
              isNull(devicesTable.revokedAt),
            ),
          )
          .limit(1)

  return activeDevices.length === 1 ? undefined : Response.json({ code: 'CLI_DEVICE_NOT_BOUND' }, { status: 409 })
}
