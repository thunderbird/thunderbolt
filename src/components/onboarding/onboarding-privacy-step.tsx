import { Checkbox } from '@/components/ui/checkbox'
import { Shield, Lock, Eye, Database } from 'lucide-react'
import type { OnboardingState } from '@/hooks/use-onboarding-state'

type OnboardingPrivacyStepProps = {
  state: OnboardingState
  actions: {
    setPrivacyAgreed: (agreed: boolean) => void
    nextStep: () => Promise<void>
    prevStep: () => Promise<void>
    skipStep: () => Promise<void>
  }
}

export const OnboardingPrivacyStep = ({ state, actions }: OnboardingPrivacyStepProps) => {
  const handleAgreementChange = (checked: boolean) => {
    actions.setPrivacyAgreed(checked)
  }

  return (
    <div className="w-full flex flex-col">
      <div className="text-center space-y-4">
        <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
          <Shield className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-2xl font-bold">Privacy & Security First</h2>
        <p className="text-sm text-muted-foreground">Your privacy is our priority.</p>
      </div>

      <div className="space-y-4 sm:space-y-3 pt-3">
        <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
          <Lock className="w-5 h-5 flex-shrink-0" />
          <div>
            <h3 className="font-medium text-sm">On-Device Processing</h3>
            <p className="text-xs text-muted-foreground">
              View and manage your schedule, create events, and get smart reminders.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
          <Eye className="w-5 h-5 flex-shrink-0" />
          <div>
            <h3 className="font-medium text-sm">No Data Collection</h3>
            <p className="text-xs text-muted-foreground">We don't collect or share your personal information.</p>
          </div>
        </div>

        <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
          <Database className="w-5 h-5 flex-shrink-0" />
          <div>
            <h3 className="font-medium text-sm">Local Storage</h3>
            <p className="text-xs text-muted-foreground">All data stored securely on your device.</p>
          </div>
        </div>
      </div>

      <div className="pt-3">
        <div className="flex items-start gap-2">
          <Checkbox
            id="terms-agreement"
            checked={state.privacyAgreed}
            onCheckedChange={(checked) => handleAgreementChange(checked === true)}
            className="mt-0.5"
          />
          <label htmlFor="terms-agreement" className="text-xs text-muted-foreground leading-relaxed">
            I agree to the{' '}
            <a
              href="https://www.thunderbird.net/en-US/privacy/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline hover:no-underline"
            >
              Privacy Policy
            </a>{' '}
            and understand how my data is handled.
          </label>
        </div>
      </div>
    </div>
  )
}
