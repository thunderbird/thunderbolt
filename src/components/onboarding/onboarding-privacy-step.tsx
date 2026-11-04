/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppLogo } from '@/components/app-logo'
import { Checkbox } from '@/components/ui/checkbox'
import type { OnboardingState } from '@/hooks/use-onboarding-state'
import { useAppName, useBrandingLinks } from '@/lib/branding-selectors'
import { Trans } from '@lingui/react/macro'
import { CodeXml, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { OnboardingFeatureCard } from './onboarding-feature-card'
import { OnboardingStepHeader } from './onboarding-step-header'

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
  const links = useBrandingLinks()
  const appName = useAppName()
  const handleAgreementChange = (checked: boolean) => {
    actions.setPrivacyAgreed(checked)
  }

  return (
    <div className="flex w-full flex-1 flex-col justify-center">
      <div className="flex flex-col">
        <OnboardingStepHeader
          icon={<AppLogo size={72} />}
          title={<Trans>Welcome to {appName}!</Trans>}
          description={
            <Trans>
              AI that <strong>you</strong> control.
            </Trans>
          }
        />

        <ul className="mt-10 rounded-xl bg-muted text-foreground/80">
          {[
            {
              id: 'private',
              icon: ShieldCheck,
              title: <Trans>Private</Trans>,
              description: <Trans>Built to protect your data.</Trans>,
            },
            {
              id: 'customizable',
              icon: SlidersHorizontal,
              title: <Trans>Customizable</Trans>,
              description: <Trans>Choose your agents, models, and tools.</Trans>,
            },
            {
              id: 'open-source',
              icon: CodeXml,
              title: <Trans>Open Source</Trans>,
              description: <Trans>Code you can inspect and improve.</Trans>,
            },
          ].map(({ id, ...feature }, index) => (
            <li
              key={id}
              className="animate-in fade-in-0 slide-in-from-bottom-3 duration-300 fill-mode-both motion-reduce:animate-none"
              style={{ animationDelay: `${index * 180}ms` }}
            >
              <OnboardingFeatureCard {...feature} className="gap-6 px-6" />
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-8">
        <div className="flex items-center gap-3 pl-1">
          <Checkbox
            id="terms-agreement"
            checked={state.privacyAgreed}
            onCheckedChange={(checked) => handleAgreementChange(checked === true)}
            className="scale-130 cursor-pointer"
          />
          <label htmlFor="terms-agreement" className="text-base text-muted-foreground leading-relaxed cursor-pointer">
            {/* One message, links inline: a language that reorders the clause has
                to be able to move the link text with it. */}
            <Trans>
              I agree to the{' '}
              <a
                href={links.privacyPolicy}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline hover:no-underline font-medium"
              >
                Privacy Policy
              </a>{' '}
              and{' '}
              <a
                href={links.termsOfService}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline hover:no-underline font-medium"
              >
                Terms of Service
              </a>
              .
            </Trans>
          </label>
        </div>
      </div>
    </div>
  )
}
