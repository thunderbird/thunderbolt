import { Mail, Calendar, HardDrive } from 'lucide-react'
import { OnboardingFooter } from './onboarding-footer'
import { GoogleLogo } from '@/components/ui/google-logo'

type OnboardingGoogleStepProps = {
  onNext: () => void
  onSkip: () => void
  onBack: () => void
}

export default function OnboardingGoogleStep({ onNext, onSkip, onBack }: OnboardingGoogleStepProps) {
  return (
    <div className="h-full flex flex-col justify-center overflow-x-hidden px-2">
      <div className="text-center space-y-4">
        <div className="mx-auto w-16 h-16 bg-white dark:bg-gray-800 rounded-full flex items-center justify-center shadow-sm border">
          <GoogleLogo className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-bold">Connect Google Account</h2>
        <p className="text-muted-foreground">
          Connect your Google account to access your calendar, email, and drive files.
        </p>
      </div>

      <div className="space-y-6 pt-3">
        <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
          <Calendar className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-medium text-sm">Calendar Access</h3>
            <p className="text-xs text-muted-foreground">
              View and manage your schedule, create events, and get smart reminders.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
          <Mail className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-medium text-sm">Email Integration</h3>
            <p className="text-xs text-muted-foreground">
              Read, compose, and organize your emails with AI-powered assistance.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
          <HardDrive className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-medium text-sm">Drive Access</h3>
            <p className="text-xs text-muted-foreground">Search and work with your Google Drive files and documents.</p>
          </div>
        </div>
      </div>

      <OnboardingFooter onBack={onBack} onSkip={onSkip} onContinue={onNext} continueText="Connect Google Account" />
    </div>
  )
}
