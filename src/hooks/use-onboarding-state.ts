/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { extractCountryFromLocation } from '@/lib/country-utils'
import { useEffect, useReducer } from 'react'
import { useCountryUnits } from './use-country-units'
import { useSettings } from './use-settings'

type OnboardingStep = 1 | 2 | 3 | 4 | 5

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
        canGoNext: action.payload < 5,
        canSkip: action.payload > 1 && action.payload < 5,
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
      const nextStep = Math.min(state.currentStep + 1, 5) as OnboardingStep
      return {
        ...state,
        currentStep: nextStep,
        canGoBack: nextStep > 1,
        canGoNext: nextStep < 5,
        canSkip: nextStep > 1 && nextStep < 5,
      }
    }

    case 'PREV_STEP': {
      const prevStep = Math.max(state.currentStep - 1, 1) as OnboardingStep
      return {
        ...state,
        currentStep: prevStep,
        canGoBack: prevStep > 1,
        canGoNext: prevStep < 5,
        canSkip: prevStep > 1 && prevStep < 5,
      }
    }

    case 'SKIP_STEP': {
      const skipStep = Math.min(state.currentStep + 1, 5) as OnboardingStep
      return {
        ...state,
        currentStep: skipStep,
        canGoBack: skipStep > 1,
        canGoNext: skipStep < 5,
        canSkip: skipStep > 1 && skipStep < 5,
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

  const {
    preferredName,
    locationName,
    locationLat,
    locationLng,
    distanceUnit,
    temperatureUnit,
    dateFormat,
    timeFormat,
    currency,
    integrationsGoogleIsEnabled,
  } = useSettings({
    preferred_name: '',
    location_name: '',
    location_lat: '',
    location_lng: '',
    distance_unit: 'imperial',
    temperature_unit: 'f',
    date_format: 'MM/DD/YYYY',
    time_format: '12h',
    currency: 'USD',
    integrations_google_is_enabled: false,
  })

  const { fetchCountryUnits } = useCountryUnits()

  // Sync with saved step on mount
  useEffect(() => {
    const savedStep = parseInt(onboardingCurrentStep.value || '1', 10)
    if (savedStep >= 1 && savedStep <= 5) {
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

  useEffect(() => {
    if (integrationsGoogleIsEnabled.value && !integrationsGoogleIsEnabled.isLoading) {
      dispatch({ type: 'SET_PROVIDER_CONNECTED', payload: true })
    }
  }, [integrationsGoogleIsEnabled.value, integrationsGoogleIsEnabled.isLoading])

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

    submitLocation: async (locationData: { locationName: string; locationLat: number; locationLng: number }) => {
      dispatch({ type: 'SUBMIT_LOCATION', payload: locationData })

      try {
        // Run sequentially to avoid "cannot start a transaction within a transaction"
        // (each setValue uses updateSettings which wraps in db.transaction)
        await locationName.setValue(locationData.locationName)
        await locationLat.setValue(String(locationData.locationLat))
        await locationLng.setValue(String(locationData.locationLng))

        const country = extractCountryFromLocation(locationData.locationName)
        if (country) {
          const countryUnitsData = await fetchCountryUnits(country)
          if (countryUnitsData) {
            await distanceUnit.setValue(countryUnitsData.unit, { recomputeHash: true })
            await temperatureUnit.setValue(countryUnitsData.temperature, { recomputeHash: true })
            await dateFormat.setValue(countryUnitsData.dateFormatExample, { recomputeHash: true })
            await timeFormat.setValue(countryUnitsData.timeFormat, { recomputeHash: true })
            await currency.setValue(countryUnitsData.currency.code, { recomputeHash: true })
          }
        }

        dispatch({ type: 'SET_SUBMITTING_LOCATION', payload: false })
      } catch (error) {
        console.error('Failed to save location data:', error)
        dispatch({ type: 'SET_SUBMITTING_LOCATION', payload: false })
        throw error
      }
    },

    nextStep: async () => {
      const newStep = Math.min(state.currentStep + 1, 5) as OnboardingStep
      dispatch({ type: 'NEXT_STEP' })
      await onboardingCurrentStep.setValue(String(newStep))
    },
    prevStep: async () => {
      const newStep = Math.max(state.currentStep - 1, 1) as OnboardingStep
      dispatch({ type: 'PREV_STEP' })
      await onboardingCurrentStep.setValue(String(newStep))
    },
    skipStep: async () => {
      const newStep = Math.min(state.currentStep + 1, 5) as OnboardingStep

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

  return { state, actions }
}

export type { OnboardingAction, OnboardingState }
