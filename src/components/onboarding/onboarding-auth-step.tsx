import { useState } from 'react'
import { Mail, Calendar, HardDrive } from 'lucide-react'
import { OnboardingFooter } from './onboarding-footer'
import { GoogleLogo } from '@/components/ui/google-logo'
import { MicrosoftLogo } from '@/components/ui/microsoft-logo'
import { type OAuthProvider } from '@/lib/auth'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'

type OnboardingAuthStepProps = {
  onNext: () => void
  onSkip: () => void
  onBack: () => void
  providers?: OAuthProvider[]
  isProcessing?: boolean
}

export const OnboardingAuthStep = ({
  onNext,
  onSkip,
  onBack,
  providers = ['google'],
  isProcessing = false,
}: OnboardingAuthStepProps) => {
  const [isConnecting, setIsConnecting] = useState(false)

  // Determine which provider to use for this step (first in list)
  const provider = providers[0]

  const { connect } = useOAuthConnect({
    onSuccess: onNext,
    setPreferredName: true,
    returnContext: 'onboarding',
  })

  const providerName = provider === 'microsoft' ? 'Microsoft' : 'Google'
  const TopIcon = provider === 'microsoft' ? MicrosoftLogo : GoogleLogo
  const storageServiceName = provider === 'microsoft' ? 'OneDrive' : 'Google Drive'
  const storageFeatureTitle = provider === 'microsoft' ? 'OneDrive Access' : 'Drive Access'

  const handleConnect = () => {
    setIsConnecting(true)
    connect(provider)
  }

  const isLoading = isProcessing || isConnecting

  return (
    <div className="h-full flex flex-col justify-center overflow-x-hidden px-2">
      <div className="text-center space-y-4">
        <div className="mx-auto w-16 h-16 bg-white dark:bg-gray-800 rounded-full flex items-center justify-center shadow-sm border">
          <TopIcon className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-bold">Connect {providerName} Account</h2>
        <p className="text-muted-foreground">
          Connect your {providerName} account to access your calendar, email, and files.
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
            <h3 className="font-medium text-sm">{storageFeatureTitle}</h3>
            <p className="text-xs text-muted-foreground">
              Search and work with your {storageServiceName} files and documents.
            </p>
          </div>
        </div>
      </div>

      <OnboardingFooter
        onBack={onBack}
        onSkip={onSkip}
        onContinue={handleConnect}
        continueText={isLoading ? 'Connecting...' : `Connect ${providerName} Account`}
        continueDisabled={isLoading}
      />
    </div>
  )
}
