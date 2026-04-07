import { useDatabase } from '@/contexts'
import { getDevice, getPendingDevices, type Device } from '@/dal'
import { isSyncEnabled } from '@/db/powersync'
import { getDeviceId } from '@/lib/auth-token'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useCallback, useState } from 'react'

const sessionStorageKey = 'pending_device_dismissed_ids'

const readDismissedIds = (): Set<string> => {
  try {
    const raw = sessionStorage.getItem(sessionStorageKey)
    if (!raw) {
      return new Set()
    }
    return new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

const writeDismissedIds = (ids: Set<string>) => {
  sessionStorage.setItem(sessionStorageKey, JSON.stringify([...ids]))
}

export const usePendingDeviceNotification = () => {
  const db = useDatabase()
  const deviceId = getDeviceId()

  const [dismissedIds, setDismissedIds] = useState(readDismissedIds)

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
  const shouldNotify = isSyncEnabled() && isCurrentDeviceTrusted

  const pendingDeviceToNotify: Device | null = shouldNotify
    ? (pendingDevices.find((d) => !dismissedIds.has(d.id)) ?? null)
    : null

  const dismissDevice = useCallback((id: string) => {
    setDismissedIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      writeDismissedIds(next)
      return next
    })
  }, [])

  return { pendingDeviceToNotify, pendingDevices, dismissDevice }
}
