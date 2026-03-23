import { useDatabase, useHttpClient } from '@/contexts'
import { getAllDevices, getPendingDevices } from '@/dal'
import { getDeviceId } from '@/lib/auth-token'
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
import { SectionCard } from '@/components/ui/section-card'
import { CheckCircle2, Loader2, Smartphone, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { approveDevice } from '@/services/encryption'

const formatLastSeen = (ts: string | null): string => {
  if (ts == null) {
    return '—'
  }
  const date = dayjs(ts)
  const now = dayjs()
  const diffMs = date.diff(now)
  return dayjs.duration(diffMs, 'millisecond').humanize(true)
}

export default function DevicesSettingsPage() {
  const db = useDatabase()
  const httpClient = useHttpClient()
  const currentDeviceId = getDeviceId()
  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['devices'],
    query: toCompilableQuery(getAllDevices(db)),
  })
  const { data: pendingDevices = [] } = useQuery({
    queryKey: ['pending-devices'],
    query: toCompilableQuery(getPendingDevices(db)),
  })
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null)
  const [approveTarget, setApproveTarget] = useState<string | null>(null)

  const visibleDevices = devices.filter((d) => d.revokedAt == null || dayjs().diff(dayjs(d.revokedAt), 'hour') < 24)

  const revokeMutation = useMutation({
    mutationFn: (deviceId: string) => httpClient.post(`account/devices/${encodeURIComponent(deviceId)}/revoke`),
    onSuccess: () => {
      setRevokeTarget(null)
    },
  })

  const approveMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      const device = pendingDevices.find((d) => d.id === deviceId)
      if (!device?.publicKey) {
        throw new Error('Device has no public key')
      }
      await approveDevice(httpClient, deviceId, device.publicKey)
    },
    onSuccess: () => {
      setApproveTarget(null)
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

  const confirmApprove = () => {
    if (approveTarget) {
      approveMutation.mutate(approveTarget)
    }
  }

  const hasPendingDevices = pendingDevices.length > 0

  return (
    <div className="flex flex-col gap-6 p-4 pb-12 w-full max-w-[760px] mx-auto">
      <PageHeader title="Devices" />

      {hasPendingDevices && (
        <>
          <SectionCard title="Pending Approvals">
            <div className="flex flex-col gap-3">
              {pendingDevices.map((device) => (
                <Card key={device.id} className="bg-secondary/50">
                  <CardContent>
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <Smartphone className="size-5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <span className="font-medium truncate">{device.name}</span>
                          <p className="text-sm text-muted-foreground">Waiting for approval</p>
                        </div>
                      </div>
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => setApproveTarget(device.id)}
                        disabled={approveMutation.isPending}
                      >
                        {approveMutation.isPending && approveMutation.variables === device.id ? (
                          <Loader2 className="size-4 mr-1 animate-spin" />
                        ) : (
                          <CheckCircle2 className="size-4 mr-1" />
                        )}
                        Approve
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </SectionCard>

          <div className="h-px bg-border" />
        </>
      )}

      {hasPendingDevices && <h3 className="text-lg font-semibold -mb-2">Trusted Devices</h3>}

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
                              This Device
                            </span>
                          )}
                          {isRevoked && (
                            <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
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

      <AlertDialog open={approveTarget !== null} onOpenChange={(open) => !open && setApproveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve this device?</AlertDialogTitle>
            <AlertDialogDescription>
              This will share your encryption key with the device, allowing it to decrypt and sync your data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approveMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmApprove} disabled={approveMutation.isPending}>
              {approveMutation.isPending ? 'Approving…' : 'Approve'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
