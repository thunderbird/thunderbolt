import { useEffect, useState } from 'react'
import { create } from 'zustand'

import { SyncSetupModal } from '@/components/sync-setup/sync-setup-modal'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { isSyncEnabled, setSyncEnabled } from '@/db/powersync'
import { useSettings } from '@/hooks/use-settings'
import { trackEvent } from '@/lib/posthog'
import { CheckCircle2, Cloud } from 'lucide-react'

export const useWelcomeStore = create<{
  pending: boolean
  trigger: () => void
  consume: () => boolean
}>((set, get) => ({
  pending: false,
  trigger: () => set({ pending: true }),
  consume: () => {
    const val = get().pending
    if (val) {
      set({ pending: false })
    }
    return val
  },
}))

/**
 * Shows a welcome dialog after successful sign-in with an optional sync CTA.
 */
export const WelcomeDialog = () => {
  const { preferredName } = useSettings({ preferred_name: '' })
  const pending = useWelcomeStore((s) => s.pending)
  const [isOpen, setIsOpen] = useState(false)
  const [showSyncSetup, setShowSyncSetup] = useState(false)

  const syncAlreadyEnabled = isSyncEnabled()

  useEffect(() => {
    if (pending) {
      useWelcomeStore.setState({ pending: false })
      setIsOpen(true)
    }
  }, [pending])

  const handleEnableSync = () => {
    setIsOpen(false)
    setShowSyncSetup(true)
  }

  const handleSyncComplete = async () => {
    await setSyncEnabled(true)
    trackEvent('settings_sync_enabled')
    setShowSyncSetup(false)
  }

  const displayName = preferredName.value as string

  return (
    <>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogTitle className="sr-only">Welcome</DialogTitle>
          <DialogDescription className="sr-only">Sign-in successful</DialogDescription>

          <div className="flex w-full flex-col items-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
              <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
            </div>

            <h2 className="mt-4 text-xl font-semibold">{displayName ? `Welcome, ${displayName}!` : 'Welcome!'}</h2>
            <p className="mt-1 text-sm text-muted-foreground">You&apos;re now signed in.</p>

            {!syncAlreadyEnabled && (
              <div className="mt-5 flex w-full items-center gap-3 rounded-lg border p-3 text-left">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <Cloud className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">Sync across devices</p>
                  <p className="text-xs text-muted-foreground">End-to-end encrypted cloud sync</p>
                </div>
                <Button size="sm" onClick={handleEnableSync}>
                  Enable
                </Button>
              </div>
            )}

            <div className="mt-6 w-full">
              <Button
                variant={syncAlreadyEnabled ? 'default' : 'ghost'}
                onClick={() => setIsOpen(false)}
                className="w-full"
              >
                {syncAlreadyEnabled ? 'Continue' : 'Not now'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <SyncSetupModal open={showSyncSetup} onOpenChange={setShowSyncSetup} onComplete={handleSyncComplete} />
    </>
  )
}
