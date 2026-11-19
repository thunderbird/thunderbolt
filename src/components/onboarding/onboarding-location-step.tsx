/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { LocationData } from '@/lib/locations'
import type { OnboardingState, useOnboardingState } from '@/hooks/use-onboarding-state'
import { Trans, useLingui } from '@lingui/react/macro'
import { MapPin } from 'lucide-react'
import { LocationSearchCombobox } from '../location-search-combobox'
import { OnboardingStepHeader } from './onboarding-step-header'

type OnboardingLocationStepProps = {
  state: Pick<OnboardingState, 'locationValue' | 'isSubmittingLocation'>
  actions: Pick<ReturnType<typeof useOnboardingState>['actions'], 'submitLocation'>
}

export const OnboardingLocationStep = ({ state, actions }: OnboardingLocationStepProps) => {
  const { t } = useLingui()
  const handleSelectLocation = async (location: LocationData) => {
    try {
      await actions.submitLocation({
        locationName: location.name,
        locationId: location.id,
        locationLat: location.coordinates.lat,
        locationLng: location.coordinates.lng,
        locationCountryCode: location.countryCode,
      })
    } catch (error) {
      console.error('Failed to save location:', error)
    }
  }

  return (
    <div className="flex w-full flex-1 flex-col justify-center">
      <OnboardingStepHeader
        icon={<MapPin className="size-10 text-primary" />}
        title={<Trans>Where are you located?</Trans>}
        description={<Trans>This helps us personalize your experience with local settings and features.</Trans>}
      />
      <div className="mt-10 space-y-6">
        <LocationSearchCombobox
          value={state.locationValue}
          disabled={state.isSubmittingLocation}
          onSelect={handleSelectLocation}
          autoOpen={!state.locationValue}
          aria-label={t`Location`}
        />
      </div>
    </div>
  )
}
