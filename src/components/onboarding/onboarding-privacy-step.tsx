import { AppLogo } from '@/components/app-logo'
import { Checkbox } from '@/components/ui/checkbox'
import type { OnboardingState } from '@/hooks/use-onboarding-state'
import { Database, EyeOff, ServerOff } from 'lucide-react'
import { IconCircle } from './icon-circle'
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
        <IconCircle>
          <AppLogo size={32} />
        </IconCircle>
        <h2 className="text-2xl font-bold">
          Welcome to <b>Thunderbolt</b>!
        </h2>
        <p className="text-sm text-muted-foreground">Your privacy-first AI assistant</p>
      </div>

      <div className="space-y-4 sm:space-y-3 pt-5">
        <OnboardingFeatureCard
          icon={ServerOff}
          title="Zero Logs"
          description="We don't keep logs of your conversations."
        />

        <OnboardingFeatureCard icon={EyeOff} title="Zero Training" description="We don't train models on your data." />

        <OnboardingFeatureCard
          icon={Database}
          title="Local Storage"
          description="Data is stored securely on your device."
        />
      </div>

      <div className="pt-5">
        <div className="flex items-start gap-3 pl-1">
          <Checkbox
            id="terms-agreement"
            checked={state.privacyAgreed}
            onCheckedChange={(checked) => handleAgreementChange(checked === true)}
            className="mt-1.5 scale-130 cursor-pointer"
          />
          <label htmlFor="terms-agreement" className="text-base text-muted-foreground leading-relaxed cursor-pointer">
            I agree to the{' '}
            <a
              href="https://www.thunderbird.net/en-US/privacy/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline hover:no-underline font-medium"
            >
              Privacy Policy
            </a>{' '}
            and{' '}
            <a
              href="https://www.mozilla.org/en-US/about/legal/terms/mozilla/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline hover:no-underline font-medium"
            >
              Terms of Service
            </a>
            .
          </label>
        </div>
      </div>
    </div>
  )
}
