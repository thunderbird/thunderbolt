import { ResponsiveModal, ResponsiveModalContent } from '@/components/ui/responsive-modal'
import { Button } from '@/components/ui/button'
import { useSyncSetup } from '@/hooks/use-sync-setup'
import { RecoveryKeyDisplayStep } from './recovery-key-display-step'
import { ApprovalWaitingStep } from './approval-waiting-step'
import { RecoveryKeyEntryStep } from './recovery-key-entry-step'
import { IconCircle } from '@/components/onboarding/icon-circle'
import { ArrowLeft, Lock, Monitor, Plus, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

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
  const [recoveryKeyConfirmed, setRecoveryKeyConfirmed] = useState(false)

  const isRecoveryKeyStep = setup.step === 'recovery-key-display'
  const canDismiss = !isRecoveryKeyStep

  const handleClose = () => {
    setup.reset()
    setRecoveryKeyConfirmed(false)
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
        if (!isOpen && canDismiss) {
          handleClose()
        }
      }}
      className="sm:min-h-0 sm:h-auto"
      showCloseButton={canDismiss}
      onInteractOutside={(e) => {
        if (!canDismiss) {
          e.preventDefault()
        }
      }}
      onEscapeKeyDown={(e) => {
        if (!canDismiss) {
          e.preventDefault()
        }
      }}
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
          <RecoveryKeyDisplayStep
            recoveryKey={setup.recoveryKey}
            onDone={handleFirstDeviceDone}
            onConfirmedChange={setRecoveryKeyConfirmed}
          />
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
  <div className="w-full flex flex-col">
    <div className="text-center space-y-4">
      <IconCircle>
        <ShieldCheck className="w-8 h-8 text-primary" />
      </IconCircle>
      <h2 className="text-2xl font-bold">Set up sync</h2>
      <p className="text-muted-foreground">
        Keep your data in sync across all your devices. Everything is encrypted end-to-end — only your devices can read
        your data.
      </p>
    </div>

    <div className="pt-5">
      <Button className="w-full" onClick={onContinue}>
        Continue
      </Button>
    </div>
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
  <div className="w-full flex flex-col">
    <div className="text-center space-y-4">
      <h2 className="text-2xl font-bold">Detecting your devices…</h2>
      <p className="text-xs text-muted-foreground/60">
        (Testing only — in production this step auto-detects via BE request)
      </p>
    </div>

    <div className="flex flex-col gap-3 pt-5">
      <Button variant="outline" className="w-full h-auto py-4 justify-start gap-3" onClick={onFirstDevice}>
        <Monitor className="w-6 h-6 shrink-0" />
        <div className="text-left">
          <div className="font-medium">First device</div>
          <div className="text-xs text-muted-foreground">No other devices have sync enabled yet</div>
        </div>
      </Button>

      <Button variant="outline" className="w-full h-auto py-4 justify-start gap-3" onClick={onAdditionalDevice}>
        <Plus className="w-6 h-6 shrink-0" />
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
  <div className="w-full flex flex-col">
    <div className="text-center space-y-4">
      <IconCircle>
        <Lock className="w-8 h-8 text-primary" />
      </IconCircle>
      <h2 className="text-2xl font-bold">First device setup</h2>
      <p className="text-muted-foreground">
        This is the first device on your account. We&apos;ll create an encryption key to protect your data and give you
        a recovery key to keep safe.
      </p>
      <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
        Please store your recovery key somewhere safe — you&apos;ll need it to access your data if you ever lose all
        your devices.
      </p>
    </div>

    <div className="pt-5">
      <Button className="w-full" onClick={onContinue}>
        Continue
      </Button>
    </div>
  </div>
)
