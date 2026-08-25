/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { ResponsiveModal, ResponsiveModalContent, ResponsiveModalTitle } from '@/components/ui/responsive-modal'
import { Button } from '@/components/ui/button'
import { useSyncSetup } from '@/hooks/use-sync-setup'
import { useApprovalPolling } from '@/hooks/use-approval-polling'
import { checkApprovalAndUnwrap } from '@/services/encryption'
import { cancelPending } from '@/api/encryption'
import { useHttpClient } from '@/contexts'
import { RecoveryKeyDisplayStep } from './recovery-key-display-step'
import { ApprovalWaitingStep } from './approval-waiting-step'
import { RecoveryKeyEntryStep } from './recovery-key-entry-step'
import { GradientCircleCheck } from '@/components/ui/gradient-circle-check'
import { IconCircle } from '@/components/onboarding/icon-circle'
import { showRevokedDeviceModalEvent } from '@/hooks/use-credential-events'
import { ArrowLeft, Loader2, Lock, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useRef } from 'react'

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
  const hasCompletedRef = useRef(false)

  // Reset wizard state when modal opens (not on close — avoids step flash during close animation)
  const prevOpen = useRef(false)
  if (open && !prevOpen.current) {
    setup.reset()
    hasCompletedRef.current = false
  }
  prevOpen.current = open

  const isRecoveryKeyStep = setup.step === 'recovery-key-display'
  const canDismiss = !isRecoveryKeyStep && !setup.isLoading

  const completeAndClose = () => {
    if (hasCompletedRef.current) {
      return
    }
    hasCompletedRef.current = true
    onComplete()
    onOpenChange(false)
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
      showSuccess()
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

  const handleRevoked = () => {
    onOpenChange(false)
    window.dispatchEvent(new CustomEvent(showRevokedDeviceModalEvent))
  }

  const handleDenied = () => {
    setup.deviceDenied()
  }

  const stepsAfterRegistration: readonly string[] = ['detecting', 'approval-waiting', 'recovery-key-entry', 'denied']

  const handleClose = () => {
    // Cancel pending state on server when closing after device was registered
    if (stepsAfterRegistration.includes(setup.step)) {
      cancelPending(httpClient).catch(() => {})
    }
    onOpenChange(false)
  }

  const { isPolling } = useApprovalPolling({
    enabled: setup.step === 'approval-waiting',
    checkApproval: () => checkApprovalAndUnwrap(httpClient),
    onApproved: showSuccess,
    onRevoked: handleRevoked,
    onDenied: handleDenied,
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
      <ResponsiveModalTitle className="sr-only">
        <Trans>Set up encrypted sync</Trans>
      </ResponsiveModalTitle>
      {setup.step === 'recovery-key-entry' && (
        <button
          type="button"
          onClick={setup.chooseAdditionalDevice}
          className="absolute left-4 top-4 flex h-[var(--touch-height-sm)] w-[var(--touch-height-sm)] cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-[var(--icon-size-default)]" />
          <span className="sr-only">
            <Trans>Go back</Trans>
          </span>
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
          <RecoveryKeyDisplayStep recoveryKey={setup.recoveryKey} onDone={handleFirstDeviceDone} />
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

        {setup.step === 'denied' && <DeniedStep onRetry={setup.reset} />}

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
      <h2 className="text-2xl font-bold">
        <Trans>Set up sync</Trans>
      </h2>
      <p className="text-muted-foreground">
        <Trans>
          Keep your data in sync across all your devices. Everything is encrypted end-to-end. Only your devices can read
          your data.
        </Trans>
      </p>
    </div>

    <div className="pt-5">
      <Button className="w-full" onClick={onContinue} disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            <Trans>Setting up…</Trans>
          </>
        ) : (
          <Trans>Continue</Trans>
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
          <h2 className="text-2xl font-bold">
            <Trans>Setting up encryption…</Trans>
          </h2>
          <p className="text-muted-foreground">
            <Trans>Registering this device and detecting your account status.</Trans>
          </p>
        </>
      )}
      {error && (
        <>
          <h2 className="text-2xl font-bold">
            <Trans>Something went wrong</Trans>
          </h2>
          <p className="text-sm text-destructive">{error}</p>
          <div className="pt-2">
            <Button onClick={onRetry}>
              <Trans>Try again</Trans>
            </Button>
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
      <h2 className="text-2xl font-bold">
        <Trans>First device setup</Trans>
      </h2>
      <p className="text-muted-foreground">
        <Trans>
          This is the first device on your account. We&apos;ll create an encryption key to protect your data and give
          you a recovery key to keep safe.
        </Trans>
      </p>
      <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
        <Trans>
          Please store your recovery key somewhere safe. You&apos;ll need it to access your data if you ever lose all
          your devices.
        </Trans>
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>

    <div className="pt-5">
      <Button className="w-full" onClick={onContinue} disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            <Trans>Generating keys…</Trans>
          </>
        ) : (
          <Trans>Continue</Trans>
        )}
      </Button>
    </div>
  </div>
)

// =============================================================================
// Setup complete step — success confirmation for additional device flows
// =============================================================================

const DeniedStep = ({ onRetry }: { onRetry: () => void }) => (
  <div className="w-full flex flex-col">
    <div className="text-center space-y-4">
      <IconCircle>
        <ShieldAlert className="w-8 h-8 text-destructive" />
      </IconCircle>
      <h2 className="text-2xl font-bold">
        <Trans>Request denied</Trans>
      </h2>
      <p className="text-muted-foreground">
        <Trans>
          Your request to sync this device was denied by another device. You can try again or close this dialog.
        </Trans>
      </p>
    </div>

    <div className="pt-5">
      <Button className="w-full" onClick={onRetry}>
        <Trans>Try again</Trans>
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
      <GradientCircleCheck className="mx-auto h-12 w-12" />
      <h2 className="text-2xl font-bold">
        <Trans>You&apos;re all set!</Trans>
      </h2>
      <p className="text-muted-foreground">
        <Trans>This device has been approved and sync is now enabled across your devices.</Trans>
      </p>
    </div>

    <div className="pt-5">
      <Button className="w-full" onClick={onDone}>
        <Trans>Done</Trans>
      </Button>
    </div>
  </div>
)
