import { Checkbox } from '@/components/ui/checkbox'
import { Shield, Lock, Eye, Database } from 'lucide-react'
import type { OnboardingState } from '@/hooks/use-onboarding-state'
import { OnboardingFeatureCard } from './onboarding-feature-card'

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

      <div className="space-y-4 sm:space-y-3 pt-5">
        <OnboardingFeatureCard
          icon={Lock}
          title="On-Device Processing"
          description="View and manage your schedule and create events."
        />

        <OnboardingFeatureCard
          icon={Eye}
          title="No Data Collection"
          description="We don't collect or share your personal information."
        />

        <OnboardingFeatureCard
          icon={Database}
          title="Local Storage"
          description="All data stored securely on your device."
        />
      </div>

      <div className="pt-5">
        <div className="flex items-start gap-3 pl-1">
          <Checkbox
            id="terms-agreement"
            checked={state.privacyAgreed}
            onCheckedChange={(checked) => handleAgreementChange(checked === true)}
            className="mt-1.5 scale-130"
          />
          <label htmlFor="terms-agreement" className="text-base text-muted-foreground leading-relaxed">
            I agree to the{' '}
            <a
              href="https://www.thunderbird.net/en-US/privacy/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline hover:no-underline font-medium"
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
