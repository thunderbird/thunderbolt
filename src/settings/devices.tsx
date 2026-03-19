import { useDatabase } from '@/contexts'
import { getAllDevices } from '@/dal'
import { getDeviceId, getAuthToken } from '@/lib/auth-token'
import { useSettings } from '@/hooks/use-settings'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useMutation } from '@tanstack/react-query'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import dayjs from 'dayjs'
import ky from 'ky'
import { Smartphone, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'

const formatLastSeen = (ts: string | null): string => {
  if (ts == null) {
    return '—'
  }
  const date = dayjs(ts)
  const now = dayjs()
  const diffMs = date.diff(now)
  return dayjs.duration(diffMs, 'millisecond').humanize(true)
}

const revokeDevice = async (deviceId: string, baseUrl: string, token: string): Promise<void> => {
  await ky.post(`account/devices/${encodeURIComponent(deviceId)}/revoke`, {
    prefixUrl: baseUrl,
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'omit',
  })
}

export default function DevicesSettingsPage() {
  const db = useDatabase()
  const currentDeviceId = getDeviceId()
  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['devices'],
    query: toCompilableQuery(getAllDevices(db)),
  })
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null)

  const visibleDevices = devices.filter((d) => d.revokedAt == null || dayjs().diff(dayjs(d.revokedAt), 'hour') < 24)

  const revokeMutation = useMutation({
    mutationFn: (deviceId: string) => {
      const token = getAuthToken()
      if (!token) {
        throw new Error('Not signed in')
      }
      return revokeDevice(deviceId, cloudUrl.value, token)
    },
    onSuccess: () => {
      setRevokeTarget(null)
    },
  })

  const handleRevoke = (deviceId: string) => {
    setRevokeTarget(deviceId)
  }

  const confirmRevoke = () => {
    if (revokeTarget) {
      revokeMutation.mutate(revokeTarget)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 pb-12 w-full max-w-[760px] mx-auto">
      <PageHeader title="Devices" />
      {isLoading ? (
        <p className="text-muted-foreground py-4">Loading devices…</p>
      ) : visibleDevices.length === 0 ? (
        <p className="text-muted-foreground py-4">No devices yet. Sign in with sync to see devices here.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {visibleDevices.map((device) => {
            const isCurrent = device.id === currentDeviceId
            const isRevoked = device.revokedAt != null
            return (
              <Card key={device.id}>
                <CardContent>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <Smartphone className="size-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium truncate">{device.name}</span>
                          {isCurrent && (
                            <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                              This device
                            </span>
                          )}
                          {isRevoked && (
                            <span className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                              Revoked
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">Last seen: {formatLastSeen(device.lastSeen)}</p>
                      </div>
                    </div>
                    {!isRevoked && !isCurrent && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRevoke(device.id)}
                        disabled={revokeMutation.isPending}
                      >
                        <Trash2 className="size-4 mr-1" />
                        Revoke
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <AlertDialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this device?</AlertDialogTitle>
            <AlertDialogDescription>
              The device will be signed out and its local data will be cleared on next sync. This device will need to
              sign in again to use sync.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRevoke} disabled={revokeMutation.isPending}>
              {revokeMutation.isPending ? 'Revoking…' : 'Revoke'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
