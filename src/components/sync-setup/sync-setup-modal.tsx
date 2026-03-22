import { ResponsiveModal, ResponsiveModalContent } from '@/components/ui/responsive-modal'
import { Button } from '@/components/ui/button'
import { useSyncSetup } from '@/hooks/use-sync-setup'
import { RecoveryKeyDisplayStep } from './recovery-key-display-step'
import { ApprovalWaitingStep } from './approval-waiting-step'
import { RecoveryKeyEntryStep } from './recovery-key-entry-step'
import { ArrowLeft, Lock, Monitor, Plus, ShieldCheck } from 'lucide-react'

type SyncSetupModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: () => void
}

/**
 * Multi-step wizard for sync/encryption setup.
 *
 * Flow: intro → detecting → (first-device-setup → recovery-key-display | approval-waiting)
 *
 * The "detecting" step uses test buttons for now. In PR 5 it will make a
 * BE request to determine firstDevice automatically.
 */
export const SyncSetupModal = ({ open, onOpenChange, onComplete }: SyncSetupModalProps) => {
  const setup = useSyncSetup()

  const handleClose = () => {
    setup.reset()
    onOpenChange(false)
  }

  const handleFirstDeviceDone = () => {
    onComplete()
    handleClose()
  }

  const handleApprovalContinue = () => {
    const success = setup.confirmApproval()
    if (success) {
      onComplete()
      handleClose()
    }
  }

  const handleRecoveryKeySubmit = () => {
    const success = setup.submitRecoveryKey()
    if (success) {
      onComplete()
      handleClose()
    }
  }

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          handleClose()
        }
      }}
      className="sm:min-h-0 sm:h-auto"
    >
      {setup.step === 'recovery-key-entry' && (
        <button
          type="button"
          onClick={setup.chooseAdditionalDevice}
          className="absolute left-4 top-4 flex h-[var(--touch-height-sm)] w-[var(--touch-height-sm)] cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-[var(--icon-size-default)]" />
          <span className="sr-only">Go back</span>
        </button>
      )}

      <ResponsiveModalContent>
        {setup.step === 'intro' && <IntroStep onContinue={setup.continueIntro} />}

        {setup.step === 'detecting' && (
          <DetectingStep onFirstDevice={setup.chooseFirstDevice} onAdditionalDevice={setup.chooseAdditionalDevice} />
        )}

        {setup.step === 'first-device-setup' && <FirstDeviceSetupStep onContinue={setup.continueFirstDeviceSetup} />}

        {setup.step === 'recovery-key-display' && (
          <RecoveryKeyDisplayStep recoveryKey={setup.recoveryKey} onDone={handleFirstDeviceDone} />
        )}

        {setup.step === 'approval-waiting' && (
          <ApprovalWaitingStep
            checked={setup.approvalChecked}
            error={setup.approvalError}
            onCheckedChange={setup.setApprovalChecked}
            onContinue={handleApprovalContinue}
            onUseRecoveryKey={setup.goToRecoveryKeyEntry}
          />
        )}

        {setup.step === 'recovery-key-entry' && (
          <RecoveryKeyEntryStep
            value={setup.recoveryKeyInput}
            error={setup.recoveryKeyError}
            onChange={setup.setRecoveryKeyInput}
            onSubmit={handleRecoveryKeySubmit}
          />
        )}
      </ResponsiveModalContent>
    </ResponsiveModal>
  )
}

// =============================================================================
// Intro step — user-facing welcome screen
// =============================================================================

const IntroStep = ({ onContinue }: { onContinue: () => void }) => (
  <div className="flex flex-col gap-6">
    <div className="flex justify-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
        <ShieldCheck className="size-6 text-primary" />
      </div>
    </div>

    <div className="text-center">
      <h2 className="text-lg font-semibold">Set up sync</h2>
      <p className="text-sm text-muted-foreground mt-2">
        Keep your data in sync across all your devices. Everything is encrypted end-to-end — only your devices can read
        your data.
      </p>
    </div>

    <Button className="w-full" onClick={onContinue}>
      Continue
    </Button>
  </div>
)

// =============================================================================
// Detecting step — test buttons for now, BE auto-detection in PR 5
// =============================================================================

type DetectingStepProps = {
  onFirstDevice: () => void
  onAdditionalDevice: () => void
}

const DetectingStep = ({ onFirstDevice, onAdditionalDevice }: DetectingStepProps) => (
  <div className="flex flex-col gap-6">
    <div className="text-center">
      <h2 className="text-lg font-semibold">Detecting your devices…</h2>
      <p className="text-xs text-muted-foreground/60 mt-1">
        (Testing only — in production this step auto-detects via BE request)
      </p>
    </div>

    <div className="flex flex-col gap-3">
      <Button variant="outline" className="w-full h-auto py-4 justify-start gap-3" onClick={onFirstDevice}>
        <Monitor className="size-5 shrink-0" />
        <div className="text-left">
          <div className="font-medium">First device</div>
          <div className="text-xs text-muted-foreground">No other devices have sync enabled yet</div>
        </div>
      </Button>

      <Button variant="outline" className="w-full h-auto py-4 justify-start gap-3" onClick={onAdditionalDevice}>
        <Plus className="size-5 shrink-0" />
        <div className="text-left">
          <div className="font-medium">Additional device</div>
          <div className="text-xs text-muted-foreground">Other trusted devices already exist</div>
        </div>
      </Button>
    </div>
  </div>
)

// =============================================================================
// First device setup step — explanation before recovery key
// =============================================================================

const FirstDeviceSetupStep = ({ onContinue }: { onContinue: () => void }) => (
  <div className="flex flex-col gap-6">
    <div className="flex justify-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
        <Lock className="size-6 text-primary" />
      </div>
    </div>

    <div className="text-center">
      <h2 className="text-lg font-semibold">First device setup</h2>
      <p className="text-sm text-muted-foreground mt-2">
        This is the first device on your account. We&apos;ll generate an encryption key and show you a recovery key to
        save. The recovery key is the only way to recover your data if you lose all your devices.
      </p>
    </div>

    <Button className="w-full" onClick={onContinue}>
      Continue
    </Button>
  </div>
)
