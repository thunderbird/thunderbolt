import { useDatabase } from '@/contexts'
import { getAllDevices, getPendingDevices } from '@/dal'
import { getDeviceId } from '@/lib/auth-token'
import { PageHeader } from '@/components/ui/page-header'
import { ApproveDeviceDialog } from '@/components/approve-device-dialog'
import { RevokeDeviceDialog } from '@/components/revoke-device-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import dayjs from 'dayjs'
import { SectionCard } from '@/components/ui/section-card'
import { CheckCircle2, Loader2, Smartphone, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useApproveDevice } from '@/hooks/use-approve-device'
import { useDenyDevice } from '@/hooks/use-deny-device'
import { useRevokeDevice } from '@/hooks/use-revoke-device'

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
  const [denyTarget, setDenyTarget] = useState<string | null>(null)
  const [approveTarget, setApproveTarget] = useState<string | null>(null)

  const visibleDevices = devices.filter((d) => {
    if (d.revokedAt != null) {
      return dayjs().diff(dayjs(d.revokedAt), 'hour') < 24
    }
    return !!d.trusted
  })

  const revokeMutation = useRevokeDevice()
  const denyMutation = useDenyDevice()
  const approveMutation = useApproveDevice(pendingDevices)

  const confirmRevoke = () => {
    if (revokeTarget) {
      revokeMutation.mutate(revokeTarget, {
        onSuccess: () => setRevokeTarget(null),
      })
    }
  }

  const confirmDeny = () => {
    if (denyTarget) {
      denyMutation.mutate(denyTarget, {
        onSuccess: () => setDenyTarget(null),
      })
    }
  }

  const confirmApprove = () => {
    if (approveTarget) {
      approveMutation.mutate(approveTarget, {
        onSuccess: () => setApproveTarget(null),
      })
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
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDenyTarget(device.id)}
                          disabled={denyMutation.isPending}
                        >
                          <Trash2 className="size-4 mr-1" />
                          Deny
                        </Button>
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
                        onClick={() => setRevokeTarget(device.id)}
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

      <ApproveDeviceDialog
        open={approveTarget !== null}
        onOpenChange={(open) => !open && setApproveTarget(null)}
        onConfirm={confirmApprove}
        isPending={approveMutation.isPending}
      />

      <RevokeDeviceDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        onConfirm={confirmRevoke}
        isPending={revokeMutation.isPending}
        variant="trusted"
      />

      <RevokeDeviceDialog
        open={denyTarget !== null}
        onOpenChange={(open) => !open && setDenyTarget(null)}
        onConfirm={confirmDeny}
        isPending={denyMutation.isPending}
        variant="pending"
      />
    </div>
  )
}
