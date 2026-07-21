/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ConnectProviderButton } from '@/components/connect-provider-button'
import { GoogleLogo } from '@/components/ui/google-logo'
import { MicrosoftLogo } from '@/components/ui/microsoft-logo'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import type { UseOAuthConnectResult } from '@/hooks/use-oauth-connect'
import { type OAuthProvider } from '@/lib/auth'
import { Calendar, File, Mail } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { OnboardingFeatureCard } from './onboarding-feature-card'
import { OnboardingStepHeader } from './onboarding-step-header'

type OnboardingAuthStepProps = {
  providers?: OAuthProvider[]
  isProcessing?: boolean
  isConnected?: boolean
  onConnectionChange: (connected: boolean) => void
  /** Revoke the provider's stored credentials. Owned by the connected parent
   *  (OnboardingDialog) so this step stays free of database access. */
  onDisconnect?: (provider: OAuthProvider) => Promise<void>
  // Optional dependency injection for testing
  useOAuthConnectHook?: () => UseOAuthConnectResult
}

export const OnboardingAuthStep = ({
  providers = ['google'],
  isProcessing = false,
  isConnected = false,
  onConnectionChange,
  onDisconnect,
  useOAuthConnectHook,
}: OnboardingAuthStepProps) => {
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

  const isMicrosoft = provider === 'microsoft'
  const providerName = isMicrosoft ? 'Microsoft' : 'Google'
  const TopIcon = isMicrosoft ? MicrosoftLogo : GoogleLogo

  const handleDisconnect = async () => {
    try {
      await onDisconnect?.(provider)
      onConnectionChange(false)
    } catch (error) {
      console.error('Failed to disconnect:', error)
    }
  }

  return (
    <div className="flex w-full flex-1 flex-col justify-center">
      <OnboardingStepHeader
        icon={<TopIcon className="size-10" />}
        title={`Connect ${providerName}`}
        description={
          isMicrosoft
            ? 'Your assistant can help you manage your email, calendar, and documents.'
            : 'Your assistant can help you manage your email and calendar.'
        }
      />

      <div className="mt-10 rounded-xl bg-muted">
        <OnboardingFeatureCard
          icon={Calendar}
          title="Calendar"
          description={
            isMicrosoft
              ? 'View and manage your schedule; create + reschedule events.'
              : 'View your schedule and upcoming events.'
          }
        />
        <OnboardingFeatureCard
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

        <div className="px-4 pb-4 pt-2">
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
            variant="default"
            className="w-full"
            useOAuthConnectHook={useOAuthConnectHook}
          />
        </div>
      </div>
    </div>
  )
}
