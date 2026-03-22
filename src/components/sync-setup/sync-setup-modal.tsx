import { ResponsiveModal, ResponsiveModalContent } from '@/components/ui/responsive-modal'
import { Button } from '@/components/ui/button'
import { useSyncSetup } from '@/hooks/use-sync-setup'
import { RecoveryKeyDisplayStep } from './recovery-key-display-step'
import { ApprovalWaitingStep } from './approval-waiting-step'
import { RecoveryKeyEntryStep } from './recovery-key-entry-step'
import { ArrowLeft, Monitor, Plus } from 'lucide-react'

type SyncSetupModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: () => void
}

/**
 * Multi-step wizard for sync/encryption setup.
 *
 * First step is a test-only flow picker (removed in PR 5 when real
 * server detection via `firstDevice: true/false` replaces it).
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
        {setup.step === 'choose-flow' && (
          <ChooseFlowStep onFirstDevice={setup.chooseFirstDevice} onAdditionalDevice={setup.chooseAdditionalDevice} />
        )}

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
// Test-only first step — removed in PR 5
// =============================================================================

type ChooseFlowStepProps = {
  onFirstDevice: () => void
  onAdditionalDevice: () => void
}

const ChooseFlowStep = ({ onFirstDevice, onAdditionalDevice }: ChooseFlowStepProps) => (
  <div className="flex flex-col gap-6">
    <div className="text-center">
      <h2 className="text-lg font-semibold">Set up sync</h2>
      <p className="text-sm text-muted-foreground mt-2">Choose a setup flow to test.</p>
      <p className="text-xs text-muted-foreground/60 mt-1">
        (This step is for testing only — removed when real server detection is wired)
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
