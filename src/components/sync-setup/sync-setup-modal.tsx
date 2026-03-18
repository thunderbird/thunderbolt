import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { useSyncSetupState } from '@/hooks/use-sync-setup-state'
import type { SyncSetupStep } from '@/hooks/use-sync-setup-state'
import { ArrowLeft } from 'lucide-react'
import { useEffect } from 'react'
import { ChooseMethodStep } from './choose-method-step'
import { CreatePassphraseStep } from './create-passphrase-step'
import { CreateShowKeyStep } from './create-show-key-step'
import { ImportPassphraseStep } from './import-passphrase-step'
import { ImportRecoveryKeyStep } from './import-recovery-key-step'
import { PasskeySetupStep } from './passkey-setup-step'
import { SuccessStep } from './success-step'

type SyncSetupModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: () => void | Promise<void>
}

const stepTitles: Record<SyncSetupStep, string> = {
  'choose-method': 'Set Up Encryption',
  'create-passphrase': 'Create Encryption Key',
  'create-show-key': 'Save Your Recovery Key',
  'import-passphrase': 'Import via Passphrase',
  'import-recovery-key': 'Import via Recovery Key',
  'passkey-setup': 'Protect Your Key',
  success: 'All Set',
}

export const SyncSetupModal = ({ open, onOpenChange, onComplete }: SyncSetupModalProps) => {
  const { state, actions } = useSyncSetupState()

  useEffect(() => {
    if (!open) {
      actions.reset()
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const canGoBack = state.step !== 'choose-method' && state.step !== 'passkey-setup' && state.step !== 'success'

  const handleComplete = async () => {
    await onComplete()
    onOpenChange(false)
  }

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange} className="min-h-0">
      <ResponsiveModalHeader className="text-left sm:text-left relative">
        {canGoBack && (
          <button
            type="button"
            onClick={actions.goBack}
            className="absolute -left-1 top-0 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
            aria-label="Go back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <ResponsiveModalTitle>{stepTitles[state.step]}</ResponsiveModalTitle>
      </ResponsiveModalHeader>

      <ResponsiveModalContent>
        {state.step === 'choose-method' && <ChooseMethodStep onSelect={actions.selectMethod} />}

        {state.step === 'create-passphrase' && (
          <CreatePassphraseStep
            isVerifying={state.isVerifying}
            error={state.error}
            onSubmitPassphrase={actions.generateKey}
            onSkip={actions.skipPassphrase}
          />
        )}

        {state.step === 'create-show-key' && (
          <CreateShowKeyStep
            recoveryKey={state.recoveryKey}
            recoveryKeySaved={state.recoveryKeySaved}
            onConfirmSaved={actions.confirmKeySaved}
            onContinue={actions.completeKeyCreation}
          />
        )}

        {state.step === 'import-passphrase' && (
          <ImportPassphraseStep
            isVerifying={state.isVerifying}
            error={state.error}
            onVerify={actions.startVerification}
          />
        )}

        {state.step === 'import-recovery-key' && (
          <ImportRecoveryKeyStep
            isVerifying={state.isVerifying}
            onVerify={actions.startRecoveryKeyVerification}
          />
        )}

        {state.step === 'passkey-setup' && (
          <PasskeySetupStep
            isRegistering={state.isRegistering}
            onSetupPasskey={actions.startPasskeyRegistration}
            onSkip={actions.skipPasskey}
          />
        )}

        {state.step === 'success' && <SuccessStep onEnableSync={handleComplete} />}
      </ResponsiveModalContent>
    </ResponsiveModal>
  )
}
