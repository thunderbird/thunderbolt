import { ConnectProviderButton } from '@/components/connect-provider-button'
import { GoogleLogo } from '@/components/ui/google-logo'
import { MicrosoftLogo } from '@/components/ui/microsoft-logo'
import { useDatabase } from '@/contexts'
import { updateSettings } from '@/dal'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import type { UseOAuthConnectResult } from '@/hooks/use-oauth-connect'
import { type OAuthProvider } from '@/lib/auth'
import { Calendar, File, Mail } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { IconCircle } from './icon-circle'
import { OnboardingFeatureCard } from './onboarding-feature-card'

type OnboardingAuthStepProps = {
  providers?: OAuthProvider[]
  isProcessing?: boolean
  isConnected?: boolean
  onConnectionChange: (connected: boolean) => void
  // Optional dependency injection for testing
  useOAuthConnectHook?: () => UseOAuthConnectResult
}

export const OnboardingAuthStep = ({
  providers = ['google'],
  isProcessing = false,
  isConnected = false,
  onConnectionChange,
  useOAuthConnectHook,
}: OnboardingAuthStepProps) => {
  const db = useDatabase()
  const location = useLocation()
  const navigate = useNavigate()

  // Determine which provider to use for this step (first in list)
  const provider = providers[0]

  const [isProcessingCallback, setIsProcessingCallback] = useState(() => {
    const locationState = location.state as { oauth?: { code?: string; state?: string; error?: string } } | null
    return !!locationState?.oauth
  })

  // Use injected hook for testing, or real implementation in production
  const oauthHook = useOAuthConnectHook ?? useOAuthConnect
  const { processCallback } = oauthHook({
    onSuccess: () => {
      onConnectionChange(true)
    },
    setPreferredName: true,
    returnContext: 'onboarding',
  })

  useEffect(() => {
    const locationState = location.state as { oauth?: { code?: string; state?: string; error?: string } } | null
    const oauth = locationState?.oauth
    if (!oauth) {
      return
    }

    const handleCallback = async () => {
      setIsProcessingCallback(true)
      try {
        await processCallback(oauth)
      } catch (err) {
        console.error('Failed to complete OAuth:', err)
      } finally {
        setIsProcessingCallback(false)
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
      await updateSettings(db, {
        [`integrations_${provider}_credentials`]: '',
        [`integrations_${provider}_is_enabled`]: 'false',
      })
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

      <div className="pt-5">
        <OnboardingFeatureCard
          className="mb-4"
          icon={Calendar}
          title="Calendar"
          description="View and manage your schedule; create + reschedule events."
        />
        <OnboardingFeatureCard
          className="mb-4"
          icon={Mail}
          title="Email"
          description="Read, compose, and organize your emails."
        />
        <OnboardingFeatureCard
          icon={File}
          title={storageFeatureTitle}
          description={`Search and work with your ${storageServiceName} files and documents.`}
        />

        <div className="flex items-start rounded-lg pt-5">
          <ConnectProviderButton
            provider={provider}
            isConnected={isConnected}
            isProcessing={isProcessing || isProcessingCallback}
            onSuccess={() => {
              onConnectionChange(true)
            }}
            onDisconnect={handleDisconnect}
            setPreferredName={true}
            returnContext="onboarding"
            allowDisconnect={true}
            className="w-full"
            useOAuthConnectHook={useOAuthConnectHook}
          />
        </div>
      </div>
    </div>
  )
}
