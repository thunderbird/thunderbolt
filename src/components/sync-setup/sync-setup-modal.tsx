import { ResponsiveModal, ResponsiveModalContent } from '@/components/ui/responsive-modal'
import { Button } from '@/components/ui/button'
import { useSyncSetup } from '@/hooks/use-sync-setup'
import { useApprovalPolling } from '@/hooks/use-approval-polling'
import { checkApprovalAndUnwrap } from '@/services/encryption'
import { useHttpClient } from '@/contexts'
import { RecoveryKeyDisplayStep } from './recovery-key-display-step'
import { ApprovalWaitingStep } from './approval-waiting-step'
import { RecoveryKeyEntryStep } from './recovery-key-entry-step'
import { IconCircle } from '@/components/onboarding/icon-circle'
import { ArrowLeft, CheckCircle, Loader2, Lock, ShieldCheck } from 'lucide-react'
import { useRef, useState } from 'react'

type SyncSetupModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: () => void
}

/**
 * Multi-step wizard for sync/encryption setup.
 *
 * Flow: intro → detecting (auto) → (first-device-setup → recovery-key-display | approval-waiting)
 */
export const SyncSetupModal = ({ open, onOpenChange, onComplete }: SyncSetupModalProps) => {
  const setup = useSyncSetup()
  const httpClient = useHttpClient()
  const [_recoveryKeyConfirmed, setRecoveryKeyConfirmed] = useState(false)
  const hasCompletedRef = useRef(false)

  const isRecoveryKeyStep = setup.step === 'recovery-key-display'
  const canDismiss = !isRecoveryKeyStep && !setup.isLoading

  const handleClose = () => {
    setup.reset()
    setRecoveryKeyConfirmed(false)
    hasCompletedRef.current = false
    onOpenChange(false)
  }

  const completeAndClose = () => {
    if (hasCompletedRef.current) {
      return
    }
    hasCompletedRef.current = true
    onComplete()
    handleClose()
  }

  const showSuccess = () => {
    setup.completeSetup()
  }

  const handleFirstDeviceDone = () => {
    completeAndClose()
  }

  const handleContinueIntro = async () => {
    const result = await setup.continueIntro()
    if (result === 'already-trusted') {
      completeAndClose()
    }
  }

  const handleContinueFirstDeviceSetup = async () => {
    await setup.continueFirstDeviceSetup()
  }

  const handleApprovalContinue = async () => {
    const success = await setup.confirmApproval()
    if (success) {
      showSuccess()
    }
  }

  const { isPolling } = useApprovalPolling({
    enabled: setup.step === 'approval-waiting',
    checkApproval: () => checkApprovalAndUnwrap(httpClient),
    onApproved: completeAndClose,
  })

  const handleRecoveryKeySubmit = async () => {
    const success = await setup.submitRecoveryKey()
    if (success) {
      showSuccess()
    }
  }

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && canDismiss) {
          if (setup.step === 'setup-complete') {
            completeAndClose()
          } else {
            handleClose()
          }
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
        {setup.step === 'intro' && <IntroStep onContinue={handleContinueIntro} isLoading={setup.isLoading} />}

        {setup.step === 'detecting' && (
          <DetectingStep isLoading={setup.isLoading} error={setup.error} onRetry={handleContinueIntro} />
        )}

        {setup.step === 'first-device-setup' && (
          <FirstDeviceSetupStep
            onContinue={handleContinueFirstDeviceSetup}
            isLoading={setup.isLoading}
            error={setup.error}
          />
        )}

        {setup.step === 'recovery-key-display' && (
          <RecoveryKeyDisplayStep
            recoveryKey={setup.recoveryKey}
            onDone={handleFirstDeviceDone}
            onConfirmedChange={setRecoveryKeyConfirmed}
          />
        )}

        {setup.step === 'approval-waiting' && (
          <ApprovalWaitingStep
            error={setup.approvalError}
            onContinue={handleApprovalContinue}
            onUseRecoveryKey={setup.goToRecoveryKeyEntry}
            isLoading={setup.isLoading}
            isPolling={isPolling}
          />
        )}

        {setup.step === 'recovery-key-entry' && (
          <RecoveryKeyEntryStep
            value={setup.recoveryKeyInput}
            error={setup.recoveryKeyError}
            onChange={setup.setRecoveryKeyInput}
            onSubmit={handleRecoveryKeySubmit}
            isLoading={setup.isLoading}
          />
        )}

        {setup.step === 'setup-complete' && <SetupCompleteStep onDone={completeAndClose} />}
      </ResponsiveModalContent>
    </ResponsiveModal>
  )
}

// =============================================================================
// Intro step
// =============================================================================

const IntroStep = ({ onContinue, isLoading }: { onContinue: () => void; isLoading: boolean }) => (
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
      <Button className="w-full" onClick={onContinue} disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Setting up…
          </>
        ) : (
          'Continue'
        )}
      </Button>
    </div>
  </div>
)

// =============================================================================
// Detecting step — auto-detects via server, shows spinner or error
// =============================================================================

type DetectingStepProps = {
  isLoading: boolean
  error: string | null
  onRetry: () => void
}

const DetectingStep = ({ isLoading, error, onRetry }: DetectingStepProps) => (
  <div className="w-full flex flex-col">
    <div className="text-center space-y-4">
      {isLoading && (
        <>
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <h2 className="text-2xl font-bold">Setting up encryption…</h2>
          <p className="text-muted-foreground">Registering this device and detecting your account status.</p>
        </>
      )}
      {error && (
        <>
          <h2 className="text-2xl font-bold">Something went wrong</h2>
          <p className="text-sm text-destructive">{error}</p>
          <div className="pt-2">
            <Button onClick={onRetry}>Try again</Button>
          </div>
        </>
      )}
    </div>
  </div>
)

// =============================================================================
// First device setup step — explanation before key generation
// =============================================================================

type FirstDeviceSetupStepProps = {
  onContinue: () => void
  isLoading: boolean
  error: string | null
}

const FirstDeviceSetupStep = ({ onContinue, isLoading, error }: FirstDeviceSetupStepProps) => (
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
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>

    <div className="pt-5">
      <Button className="w-full" onClick={onContinue} disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Generating keys…
          </>
        ) : (
          'Continue'
        )}
      </Button>
    </div>
  </div>
)

// =============================================================================
// Setup complete step — success confirmation for additional device flows
// =============================================================================

const SetupCompleteStep = ({ onDone }: { onDone: () => void }) => (
  <div className="w-full flex flex-col">
    <div className="text-center space-y-4">
      <IconCircle>
        <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
      </IconCircle>
      <h2 className="text-2xl font-bold">You&apos;re all set!</h2>
      <p className="text-muted-foreground">
        This device has been approved and sync is now enabled across your devices.
      </p>
    </div>

    <div className="pt-5">
      <Button className="w-full" onClick={onDone}>
        Done
      </Button>
    </div>
  </div>
)
