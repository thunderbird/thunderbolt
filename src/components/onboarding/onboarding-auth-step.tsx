import { ConnectProviderButton } from '@/components/connect-provider-button'
import { GoogleLogo } from '@/components/ui/google-logo'
import { MicrosoftLogo } from '@/components/ui/microsoft-logo'
import { updateSetting } from '@/dal'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import { type OAuthProvider } from '@/lib/auth'
import { Calendar, File, Mail } from 'lucide-react'
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { IconCircle } from './icon-circle'
import { OnboardingFeatureCard } from './onboarding-feature-card'

type OnboardingAuthStepProps = {
  providers?: OAuthProvider[]
  isProcessing?: boolean
  isConnected?: boolean
  onConnectionChange: (connected: boolean) => void
}

export const OnboardingAuthStep = ({
  providers = ['google'],
  isProcessing = false,
  isConnected = false,
  onConnectionChange,
}: OnboardingAuthStepProps) => {
  const location = useLocation()
  const navigate = useNavigate()

  // Determine which provider to use for this step (first in list)
  const provider = providers[0]

  const { processCallback } = useOAuthConnect({
    onSuccess: () => {
      onConnectionChange(true)
    },
    setPreferredName: true,
    returnContext: 'onboarding',
  })

  useEffect(() => {
    const locationState = location.state as { oauth?: { code?: string; state?: string; error?: string } } | null
    const oauth = locationState?.oauth
    if (!oauth) return

    const handleCallback = async () => {
      try {
        await processCallback(oauth)
      } catch (err) {
        console.error('Failed to complete OAuth:', err)
      } finally {
        navigate('.', { replace: true, state: null })
      }
    }

    handleCallback()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  const providerName = provider === 'microsoft' ? 'Microsoft' : 'Google'
  const TopIcon = provider === 'microsoft' ? MicrosoftLogo : GoogleLogo
  const storageServiceName = provider === 'microsoft' ? 'OneDrive' : 'Google Drive'
  const storageFeatureTitle = provider === 'microsoft' ? 'OneDrive Access' : 'Drive'

  const handleDisconnect = async () => {
    try {
      await updateSetting(`integrations_${provider}_credentials`, '')
      await updateSetting(`integrations_${provider}_is_enabled`, 'false')
      onConnectionChange(false)
    } catch (error) {
      console.error('Failed to disconnect:', error)
    }
  }

  return (
    <div className="w-full flex flex-col">
      <div className="text-center space-y-4">
        <IconCircle>
          <TopIcon className="w-8 h-8" />
        </IconCircle>
        <h2 className="text-2xl font-bold">Connect {providerName}</h2>
        <p className="text-muted-foreground">Your assistant can help you manage your email, calendar, and documents.</p>
      </div>

      <div className="space-y-4 sm:space-y-3 pt-5">
        <OnboardingFeatureCard
          icon={Calendar}
          title="Calendar"
          description="View and manage your schedule; create + reschedule events."
        />
        <OnboardingFeatureCard icon={Mail} title="Email" description="Read, compose, and organize your emails." />
        <OnboardingFeatureCard
          icon={File}
          title={storageFeatureTitle}
          description={`Search and work with your ${storageServiceName} files and documents.`}
        />

        <div className="flex items-start rounded-lg pt-5">
          <ConnectProviderButton
            provider={provider}
            isConnected={isConnected || isProcessing}
            onSuccess={() => {
              onConnectionChange(true)
            }}
            onDisconnect={handleDisconnect}
            setPreferredName={true}
            returnContext="onboarding"
            allowDisconnect={true}
            className="w-full"
          />
        </div>
      </div>
    </div>
  )
}
