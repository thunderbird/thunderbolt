import { getAllDevices } from '@/dal'
import { getDeviceId, getAuthToken } from '@/lib/auth-token'
import { useSettings } from '@/hooks/use-settings'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { SectionCard } from '@/components/ui/section-card'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ky from 'ky'
import { Smartphone, Trash2 } from 'lucide-react'
import { useState } from 'react'
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

const formatLastSeen = (ts: number | null): string => {
  if (ts == null) return '—'
  const date = new Date(ts * 1000)
  const now = Date.now()
  const diffMs = now - date.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

const revokeDevice = async (deviceId: string, baseUrl: string, token: string): Promise<void> => {
  await ky.post(`account/devices/${encodeURIComponent(deviceId)}/revoke`, {
    prefixUrl: baseUrl,
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'omit',
  })
}

export default function DevicesSettingsPage() {
  const queryClient = useQueryClient()
  const currentDeviceId = getDeviceId()
  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: getAllDevices,
  })
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })
  const baseUrl = cloudUrl.value ?? 'http://localhost:8000/v1'
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null)

  const revokeMutation = useMutation({
    mutationFn: (deviceId: string) => {
      const token = getAuthToken()
      if (!token) throw new Error('Not signed in')
      return revokeDevice(deviceId, baseUrl, token)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      setRevokeTarget(null)
    },
  })

  const handleRevoke = (deviceId: string) => {
    setRevokeTarget(deviceId)
  }

  const confirmRevoke = () => {
    if (revokeTarget) revokeMutation.mutate(revokeTarget)
  }

  return (
    <div className="flex flex-col gap-4 p-4 pb-12 w-full max-w-[760px] mx-auto">
      <PageHeader title="Devices" />
      <p className="text-sm text-muted-foreground">
        Devices that have signed in to your account. Revoking a device signs it out and clears its local data on next
        sync.
      </p>
      <SectionCard title="Connected devices">
        {isLoading ? (
          <p className="text-muted-foreground py-4">Loading devices…</p>
        ) : devices.length === 0 ? (
          <p className="text-muted-foreground py-4">No devices yet. Sign in with sync to see devices here.</p>
        ) : (
          <ul className="divide-y divide-border">
            {devices.map((device) => {
              const isCurrent = device.id === currentDeviceId
              const isRevoked = device.revokedAt != null
              return (
                <li key={device.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Smartphone className="size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium truncate">{device.name}</span>
                        {isCurrent && (
                          <span className="shrink-0 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
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
                </li>
              )
            })}
          </ul>
        )}
      </SectionCard>

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
