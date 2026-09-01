/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { updateSettings } from '@/dal'
import { unitDefaultsForRegion } from '@/i18n/region-units'
import { useEffect, useReducer } from 'react'
import { useIntegrationStatus } from './use-integration-status'
import { useSettings } from './use-settings'

type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6

/** Total wizard steps; the last one is the celebration, which ends the wizard. */
export const onboardingStepCount = 6

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
  | { type: 'SET_NAME_VALID'; payload: boolean }
  | { type: 'SET_SUBMITTING_NAME'; payload: boolean }
  | { type: 'SET_LOCATION_VALUE'; payload: string }
  | { type: 'SET_LOCATION_VALID'; payload: boolean }
  | { type: 'SET_SUBMITTING_LOCATION'; payload: boolean }
  | { type: 'SUBMIT_LOCATION'; payload: { locationName: string; locationLat: number; locationLng: number } }
  | { type: 'NEXT_STEP' }
  | { type: 'PREV_STEP' }
  | { type: 'SKIP_STEP' }

const initialState: OnboardingState = {
  currentStep: 1,
  privacyAgreed: false,
  isProviderConnected: false,
  isConnecting: false,
  processingOAuth: false,
  nameValue: '',
  isNameValid: false,
  isSubmittingName: false,
  locationValue: '',
  isLocationValid: false,
  isSubmittingLocation: false,
  canGoBack: false,
  canGoNext: true,
  canSkip: false,
}

const onboardingReducer = (state: OnboardingState, action: OnboardingAction): OnboardingState => {
  switch (action.type) {
    case 'SET_CURRENT_STEP':
      return {
        ...state,
        currentStep: action.payload,
        canGoBack: action.payload > 1,
        canGoNext: action.payload < onboardingStepCount,
        canSkip: action.payload > 1 && action.payload < onboardingStepCount,
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
        isNameValid: action.payload.trim().length > 0,
        canGoNext: action.payload.trim().length > 0,
      }

    case 'SET_NAME_VALID':
      return {
        ...state,
        isNameValid: action.payload,
        canGoNext: action.payload,
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

    case 'NEXT_STEP': {
      const nextStep = Math.min(state.currentStep + 1, onboardingStepCount) as OnboardingStep
      return {
        ...state,
        currentStep: nextStep,
        canGoBack: nextStep > 1,
        canGoNext: nextStep < onboardingStepCount,
        canSkip: nextStep > 1 && nextStep < onboardingStepCount,
      }
    }

    case 'PREV_STEP': {
      const prevStep = Math.max(state.currentStep - 1, 1) as OnboardingStep
      return {
        ...state,
        currentStep: prevStep,
        canGoBack: prevStep > 1,
        canGoNext: prevStep < onboardingStepCount,
        canSkip: prevStep > 1 && prevStep < onboardingStepCount,
      }
    }

    case 'SKIP_STEP': {
      const skipStep = Math.min(state.currentStep + 1, onboardingStepCount) as OnboardingStep
      return {
        ...state,
        currentStep: skipStep,
        canGoBack: skipStep > 1,
        canGoNext: skipStep < onboardingStepCount,
        canSkip: skipStep > 1 && skipStep < onboardingStepCount,
      }
    }

    default:
      return state
  }
}

/**
 * Hook for managing onboarding state and actions
 */
export const useOnboardingState = () => {
  const [state, dispatch] = useReducer(onboardingReducer, initialState)

  // Settings integration for persistence
  const { onboardingCurrentStep } = useSettings({
    onboarding_current_step: '1',
  })

  const db = useDatabase()
  // Only `preferred_name` is read back here; everything else onboarding touches
  // is write-only and goes through `setValues`.
  const { preferredName } = useSettings({ preferred_name: '' })
  const { data: integrationStatusData } = useIntegrationStatus()

  // Sync with saved step on mount
  useEffect(() => {
    const savedStep = parseInt(onboardingCurrentStep.value || '1', 10)
    if (savedStep >= 1 && savedStep <= onboardingStepCount) {
      dispatch({ type: 'SET_CURRENT_STEP', payload: savedStep as OnboardingStep })
    }
  }, [onboardingCurrentStep.value])

  // Load existing name value from database on mount
  useEffect(() => {
    if (preferredName.value && !preferredName.isLoading && preferredName.value.trim().length > 0) {
      dispatch({ type: 'SET_NAME_VALUE', payload: preferredName.value })
      dispatch({ type: 'SET_NAME_VALID', payload: true })
    }
  }, [preferredName.value, preferredName.isLoading])

  const isProviderConnected = state.isProviderConnected || (integrationStatusData?.googleConnected ?? false)

  const actions = {
    setCurrentStep: (step: OnboardingStep) => dispatch({ type: 'SET_CURRENT_STEP', payload: step }),
    setPrivacyAgreed: (agreed: boolean) => dispatch({ type: 'SET_PRIVACY_AGREED', payload: agreed }),
    setProviderConnected: (connected: boolean) => dispatch({ type: 'SET_PROVIDER_CONNECTED', payload: connected }),
    setConnecting: (connecting: boolean) => dispatch({ type: 'SET_CONNECTING', payload: connecting }),
    setProcessingOAuth: (processing: boolean) => dispatch({ type: 'SET_PROCESSING_OAUTH', payload: processing }),
    setNameValue: (value: string) => dispatch({ type: 'SET_NAME_VALUE', payload: value }),
    setNameValid: (valid: boolean) => dispatch({ type: 'SET_NAME_VALID', payload: valid }),
    setSubmittingName: (submitting: boolean) => dispatch({ type: 'SET_SUBMITTING_NAME', payload: submitting }),
    setLocationValue: (value: string) => dispatch({ type: 'SET_LOCATION_VALUE', payload: value }),
    setLocationValid: (valid: boolean) => dispatch({ type: 'SET_LOCATION_VALID', payload: valid }),
    setSubmittingLocation: (submitting: boolean) => dispatch({ type: 'SET_SUBMITTING_LOCATION', payload: submitting }),

    submitName: async (name: string) => {
      dispatch({ type: 'SET_NAME_VALUE', payload: name })
      dispatch({ type: 'SET_NAME_VALID', payload: true })
      dispatch({ type: 'SET_SUBMITTING_NAME', payload: true })

      try {
        await preferredName.setValue(name)

        dispatch({ type: 'SET_SUBMITTING_NAME', payload: false })
      } catch (error) {
        console.error('Failed to save name:', error)
        dispatch({ type: 'SET_SUBMITTING_NAME', payload: false })
        throw error
      }
    },

    submitLocation: async (locationData: {
      locationName: string
      locationLat: number
      locationLng: number
      locationCountryCode: string
    }) => {
      dispatch({ type: 'SUBMIT_LOCATION', payload: locationData })

      try {
        await updateSettings(db, {
          location_name: locationData.locationName,
          location_lat: String(locationData.locationLat),
          location_lng: String(locationData.locationLng),
          location_country_code: locationData.locationCountryCode,
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
      const newStep = Math.min(state.currentStep + 1, onboardingStepCount) as OnboardingStep
      dispatch({ type: 'NEXT_STEP' })
      await onboardingCurrentStep.setValue(String(newStep))
    },
    prevStep: async () => {
      const newStep = Math.max(state.currentStep - 1, 1) as OnboardingStep
      dispatch({ type: 'PREV_STEP' })
      await onboardingCurrentStep.setValue(String(newStep))
    },
    skipStep: async () => {
      const newStep = Math.min(state.currentStep + 1, onboardingStepCount) as OnboardingStep

      if (state.currentStep === 3) {
        try {
          await preferredName.setValue('')
          dispatch({ type: 'SET_NAME_VALUE', payload: '' })
          dispatch({ type: 'SET_NAME_VALID', payload: false })
        } catch (error) {
          console.error('Failed to clear name when skipping:', error)
        }
      }

      dispatch({ type: 'SKIP_STEP' })
      await onboardingCurrentStep.setValue(String(newStep))
    },
  }

  return { state: { ...state, isProviderConnected }, actions }
}

export type { OnboardingAction, OnboardingState }
