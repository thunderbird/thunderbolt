/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ConnectProviderButton } from '@/components/connect-provider-button'
import { GoogleLogo } from '@/components/ui/google-logo'
import { MicrosoftLogo } from '@/components/ui/microsoft-logo'
import { useDatabase } from '@/contexts'
import { deleteIntegrationCredentials } from '@/dal'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import type { UseOAuthConnectResult } from '@/hooks/use-oauth-connect'
import { type OAuthProvider } from '@/lib/auth'
import { useQueryClient } from '@tanstack/react-query'
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
  const queryClient = useQueryClient()

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

  const isMicrosoft = provider === 'microsoft'
  const providerName = isMicrosoft ? 'Microsoft' : 'Google'
  const TopIcon = isMicrosoft ? MicrosoftLogo : GoogleLogo

  const handleDisconnect = async () => {
    try {
      await deleteIntegrationCredentials(db, provider)
      await queryClient.invalidateQueries({ queryKey: ['integrationStatus'] })
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
        <p className="text-muted-foreground">
          {isMicrosoft
            ? 'Your assistant can help you manage your email, calendar, and documents.'
            : 'Your assistant can help you manage your email and calendar.'}
        </p>
      </div>

      <div className="pt-5">
        <OnboardingFeatureCard
          className="mb-4"
          icon={Calendar}
          title="Calendar"
          description={
            isMicrosoft
              ? 'View and manage your schedule; create + reschedule events.'
              : 'View your schedule and upcoming events.'
          }
        />
        <OnboardingFeatureCard
          className="mb-4"
          icon={Mail}
          title="Email"
          description={
            isMicrosoft ? 'Read, compose, and organize your emails.' : 'Read your emails and compose drafts.'
          }
        />
        {isMicrosoft && (
          <OnboardingFeatureCard
            icon={File}
            title="OneDrive Access"
            description="Search and work with your OneDrive files and documents."
          />
        )}

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
