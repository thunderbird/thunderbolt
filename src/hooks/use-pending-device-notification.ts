/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getDevice, getPendingDevices, type Device } from '@/dal'
import { isEncryptionEnabled } from '@/db/encryption'
import { isSyncEnabled } from '@/db/powersync'
import { getDeviceId } from '@/lib/auth-token'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'

export const usePendingDeviceNotification = () => {
  const db = useDatabase()
  const deviceId = getDeviceId()

  const { data: pendingDevices = [] } = useQuery({
    queryKey: ['pending-devices'],
    query: toCompilableQuery(getPendingDevices(db)),
  })

  const { data: currentDeviceRows = [] } = useQuery({
    queryKey: ['devices', deviceId],
    query: toCompilableQuery(getDevice(db, deviceId)),
  })

  const currentDevice = currentDeviceRows[0] ?? null
  const isCurrentDeviceTrusted = currentDevice?.trusted === 1
  const shouldNotify = isEncryptionEnabled() && isSyncEnabled() && isCurrentDeviceTrusted

  const pendingDeviceToNotify: Device | null = shouldNotify ? (pendingDevices[0] ?? null) : null

  return { pendingDeviceToNotify, pendingDevices }
}
