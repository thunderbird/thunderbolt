import { useState, useEffect } from 'react'
import { Mail, Calendar, HardDrive, Check } from 'lucide-react'
import { GoogleLogo } from '@/components/ui/google-logo'
import { MicrosoftLogo } from '@/components/ui/microsoft-logo'
import { type OAuthProvider } from '@/lib/auth'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import { Button } from '@/components/ui/button'
import { useLocation, useNavigate } from 'react-router'
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
  const [isConnecting, setIsConnecting] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  // Determine which provider to use for this step (first in list)
  const provider = providers[0]

  const { connect, processCallback } = useOAuthConnect({
    onSuccess: () => {
      setIsConnecting(false)
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
      setIsConnecting(true)
      try {
        await processCallback(oauth)
      } catch (err) {
        console.error('Failed to complete OAuth:', err)
        setIsConnecting(false)
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
  const storageFeatureTitle = provider === 'microsoft' ? 'OneDrive Access' : 'Drive Access'

  const handleConnect = () => {
    if (isConnected) return
    setIsConnecting(true)
    connect(provider)
  }

  const isLoading = isProcessing || isConnecting

  return (
    <div className="w-full flex flex-col">
      <div className="text-center space-y-4">
        <div className="mx-auto w-16 h-16 bg-white dark:bg-gray-800 rounded-full flex items-center justify-center shadow-sm border">
          <TopIcon className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-bold">Connect {providerName} Account</h2>
        <p className="text-muted-foreground">
          Connect your {providerName} account to access your calendar, email, and files.
        </p>
      </div>

      <div className="space-y-4 sm:space-y-3 pt-5">
        <OnboardingFeatureCard
          icon={Calendar}
          title="Calendar Access"
          description="View and manage your schedule, create events, and get smart reminders."
        />

        <OnboardingFeatureCard
          icon={Mail}
          title="Email Integration"
          description="Read, compose, and organize your emails with AI-powered assistance."
        />

        <OnboardingFeatureCard
          icon={HardDrive}
          title={storageFeatureTitle}
          description={`Search and work with your ${storageServiceName} files and documents.`}
        />

        <div className="flex items-start rounded-lg pt-5">
          <Button
            onClick={handleConnect}
            disabled={isLoading}
            variant={isConnected ? 'ghost' : 'default'}
            className="w-full"
          >
            {isConnected ? (
              <>
                <Check className="w-4 h-4 mr-2 text-green-600" />
                Connected!
              </>
            ) : isLoading ? (
              'Connecting...'
            ) : (
              `Connect ${providerName}`
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
