/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase, useHttpClient } from '@/contexts'
import { updateSettings } from '@/dal'
import { unitDefaultsForRegion } from '@/i18n/region-units'
import { useActiveLocale } from '@/i18n/use-active-locale'
import { fetchEnglishLocationName } from '@/lib/locations'
import { useEffect, useReducer } from 'react'
import { useIntegrationStatus } from './use-integration-status'
import { useSettings } from './use-settings'

export type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10

/** Total wizard steps; the last one is the celebration, which ends the wizard.
 *  Step 6 is the passkey step, appended before the celebration so the
 *  earlier steps keep their numbers. */
export const onboardingStepCount = 7

/** Keep persisted connected steps stable while inserting device-only setup. */
export const getOnboardingSteps = (isStandalone: boolean, hasBuiltInSearch = false): readonly OnboardingStep[] =>
  isStandalone ? (hasBuiltInSearch ? [1, 8, 9, 3, 5, 7] : [1, 8, 9, 10, 3, 5, 7]) : [1, 2, 3, 4, 5, 6, 7]

/** Maps a saved step into the current server mode after a connection change. */
export const resolveOnboardingStep = (
  step: OnboardingStep,
  isStandalone: boolean,
  hasBuiltInSearch = false,
): OnboardingStep => {
  if (isStandalone && hasBuiltInSearch && step === 10) {
    return 3
  }
  if (getOnboardingSteps(isStandalone, hasBuiltInSearch).includes(step)) {
    return step
  }
  return isStandalone ? 8 : 2
}

type OnboardingState = {
  currentStep: OnboardingStep
  // Step 1: Privacy
  privacyAgreed: boolean
  // Step 2: Auth
  isProviderConnected: boolean
  isConnecting: boolean
  processingOAuth: boolean
  // Step 3: Name
  nameValue: string
  isNameValid: boolean
  isSubmittingName: boolean
  // Step 4: Location
  locationValue: string
  isLocationValid: boolean
  isSubmittingLocation: boolean
  // General
  canGoBack: boolean
  canGoNext: boolean
  canSkip: boolean
}

type OnboardingAction =
  | { type: 'SET_CURRENT_STEP'; payload: OnboardingStep }
  | { type: 'SET_PRIVACY_AGREED'; payload: boolean }
  | { type: 'SET_PROVIDER_CONNECTED'; payload: boolean }
  | { type: 'SET_CONNECTING'; payload: boolean }
  | { type: 'SET_PROCESSING_OAUTH'; payload: boolean }
  | { type: 'SET_NAME_VALUE'; payload: string }
  | { type: 'SET_SUBMITTING_NAME'; payload: boolean }
  | { type: 'SET_LOCATION_VALUE'; payload: string }
  | { type: 'SET_LOCATION_VALID'; payload: boolean }
  | { type: 'SET_SUBMITTING_LOCATION'; payload: boolean }
  | { type: 'SUBMIT_LOCATION'; payload: { locationName: string; locationLat: number; locationLng: number } }

type OnboardingDraft = Omit<OnboardingState, 'nameValue' | 'isNameValid'> & { nameValue: string | null }

const initialState: OnboardingDraft = {
  currentStep: 1,
  privacyAgreed: false,
  isProviderConnected: false,
  isConnecting: false,
  processingOAuth: false,
  nameValue: null,
  isSubmittingName: false,
  locationValue: '',
  isLocationValid: false,
  isSubmittingLocation: false,
  canGoBack: false,
  canGoNext: true,
  canSkip: false,
}

const onboardingReducer = (state: OnboardingDraft, action: OnboardingAction): OnboardingDraft => {
  switch (action.type) {
    case 'SET_CURRENT_STEP':
      return {
        ...state,
        currentStep: action.payload,
        canGoBack: action.payload > 1,
        canGoNext: action.payload !== onboardingStepCount,
        canSkip: action.payload > 1 && action.payload !== onboardingStepCount,
      }

    case 'SET_PRIVACY_AGREED':
      return {
        ...state,
        privacyAgreed: action.payload,
        canGoNext: action.payload,
      }

    case 'SET_PROVIDER_CONNECTED':
      return {
        ...state,
        isProviderConnected: action.payload,
        canGoNext: action.payload,
      }

    case 'SET_CONNECTING':
      return {
        ...state,
        isConnecting: action.payload,
      }

    case 'SET_PROCESSING_OAUTH':
      return {
        ...state,
        processingOAuth: action.payload,
      }

    case 'SET_NAME_VALUE':
      return {
        ...state,
        nameValue: action.payload,
        canGoNext: action.payload.trim().length > 0,
      }

    case 'SET_SUBMITTING_NAME':
      return {
        ...state,
        isSubmittingName: action.payload,
      }

    case 'SET_LOCATION_VALUE':
      return {
        ...state,
        locationValue: action.payload,
        isLocationValid: action.payload.trim().length > 0,
        canGoNext: action.payload.trim().length > 0,
      }

    case 'SET_LOCATION_VALID':
      return {
        ...state,
        isLocationValid: action.payload,
        canGoNext: action.payload,
      }

    case 'SET_SUBMITTING_LOCATION':
      return {
        ...state,
        isSubmittingLocation: action.payload,
      }

    case 'SUBMIT_LOCATION':
      return {
        ...state,
        locationValue: action.payload.locationName,
        isLocationValid: true,
        isSubmittingLocation: true,
      }

    default:
      return state
  }
}

/**
 * Hook for managing onboarding state and actions
 */
export const useOnboardingState = ({
  isStandalone = false,
  hasBuiltInSearch = false,
}: { isStandalone?: boolean; hasBuiltInSearch?: boolean } = {}) => {
  const [state, dispatch] = useReducer(onboardingReducer, initialState)

  // Settings integration for persistence
  const { onboardingCurrentStep } = useSettings({
    onboarding_current_step: '1',
  })

  const db = useDatabase()
  const httpClient = useHttpClient()
  const locale = useActiveLocale()
  // Only `preferred_name` is read back here; everything else onboarding touches
  // is write-only and goes through `setValues`.
  const { preferredName } = useSettings({ preferred_name: '' })
  const { data: integrationStatusData } = useIntegrationStatus()

  // Sync with saved step on mount
  useEffect(() => {
    const savedStep = parseInt(onboardingCurrentStep.value || '1', 10)
    if (savedStep >= 1 && savedStep <= 10) {
      dispatch({ type: 'SET_CURRENT_STEP', payload: savedStep as OnboardingStep })
    }
  }, [onboardingCurrentStep.value])

  // An untouched draft follows saved data; typing (including clearing) owns the value from then on.
  const nameValue = state.nameValue ?? preferredName.value

  const isProviderConnected = state.isProviderConnected || (integrationStatusData?.googleConnected ?? false)

  const currentStep = resolveOnboardingStep(state.currentStep, isStandalone, hasBuiltInSearch)
  const steps = getOnboardingSteps(isStandalone, hasBuiltInSearch)
  const stepIndex = steps.indexOf(currentStep)
  const setCurrentStep = async (step: OnboardingStep) => {
    dispatch({ type: 'SET_CURRENT_STEP', payload: step })
    await onboardingCurrentStep.setValue(String(step))
  }
  const adjacentStep = (offset: number) => steps[Math.max(0, Math.min(stepIndex + offset, steps.length - 1))]

  const actions = {
    setCurrentStep: (step: OnboardingStep) => dispatch({ type: 'SET_CURRENT_STEP', payload: step }),
    goToStep: setCurrentStep,
    setPrivacyAgreed: (agreed: boolean) => dispatch({ type: 'SET_PRIVACY_AGREED', payload: agreed }),
    setProviderConnected: (connected: boolean) => dispatch({ type: 'SET_PROVIDER_CONNECTED', payload: connected }),
    setConnecting: (connecting: boolean) => dispatch({ type: 'SET_CONNECTING', payload: connecting }),
    setProcessingOAuth: (processing: boolean) => dispatch({ type: 'SET_PROCESSING_OAUTH', payload: processing }),
    setNameValue: (value: string) => dispatch({ type: 'SET_NAME_VALUE', payload: value }),
    setSubmittingName: (submitting: boolean) => dispatch({ type: 'SET_SUBMITTING_NAME', payload: submitting }),
    setLocationValue: (value: string) => dispatch({ type: 'SET_LOCATION_VALUE', payload: value }),
    setLocationValid: (valid: boolean) => dispatch({ type: 'SET_LOCATION_VALID', payload: valid }),
    setSubmittingLocation: (submitting: boolean) => dispatch({ type: 'SET_SUBMITTING_LOCATION', payload: submitting }),

    submitName: async (name: string) => {
      dispatch({ type: 'SET_NAME_VALUE', payload: name })
      dispatch({ type: 'SET_SUBMITTING_NAME', payload: true })

      try {
        await preferredName.setValue(name)
      } finally {
        dispatch({ type: 'SET_SUBMITTING_NAME', payload: false })
      }
    },

    submitLocation: async (locationData: {
      /** The localized string the user picked; what the wizard keeps showing. */
      locationName: string
      locationId: number
      locationLat: number
      locationLng: number
      locationCountryCode: string
    }) => {
      dispatch({ type: 'SUBMIT_LOCATION', payload: locationData })

      try {
        await updateSettings(db, {
          location_name: await fetchEnglishLocationName(
            httpClient,
            locationData.locationId,
            locationData.locationName,
            locale,
          ),
          location_lat: String(locationData.locationLat),
          location_lng: String(locationData.locationLng),
          location_country_code: locationData.locationCountryCode,
          location_id: String(locationData.locationId),
          // The localized string the user picked, stored so the settings page
          // never has to re-resolve it over the network.
          location_name_display: locationData.locationName,
        })

        // Applied without a prompt, unlike the same change in preferences: the
        // user is setting the app up, and their location is a better signal than
        // whatever `useUnitDefaults` seeded from the browser. `recomputeHash`
        // keeps them seeded defaults rather than user edits.
        if (locationData.locationCountryCode) {
          const units = unitDefaultsForRegion(locationData.locationCountryCode)
          await updateSettings(
            db,
            {
              distance_unit: units.distanceUnit,
              temperature_unit: units.temperatureUnit,
              time_format: units.timeFormat,
              currency: units.currency,
            },
            { recomputeHash: true },
          )
        }

        dispatch({ type: 'SET_SUBMITTING_LOCATION', payload: false })
      } catch (error) {
        console.error('Failed to save location data:', error)
        dispatch({ type: 'SET_SUBMITTING_LOCATION', payload: false })
        throw error
      }
    },

    nextStep: async () => {
      await setCurrentStep(adjacentStep(1))
    },
    prevStep: async () => {
      await setCurrentStep(adjacentStep(-1))
    },
    skipStep: async () => {
      if (currentStep === 3) {
        try {
          await preferredName.setValue('')
          dispatch({ type: 'SET_NAME_VALUE', payload: '' })
        } catch (error) {
          console.error('Failed to clear name when skipping:', error)
        }
      }

      await setCurrentStep(adjacentStep(1))
    },
  }

  return {
    state: {
      ...state,
      nameValue,
      isNameValid: nameValue.trim().length > 0,
      currentStep,
      isProviderConnected,
      canGoBack: stepIndex > 0,
      canSkip: stepIndex > 0 && stepIndex < steps.length - 1,
    },
    actions,
    stepIndex,
    totalSteps: steps.length,
  }
}

export type { OnboardingAction, OnboardingState }
