/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase, useHttpClient } from '@/contexts'
import { updateSettings } from '@/dal'
import { unitDefaultsForRegion } from '@/i18n/region-units'
import { useActiveLocale } from '@/i18n/use-active-locale'
import { fetchEnglishLocationName } from '@/lib/locations'
import { useReducer } from 'react'
import { useAsyncAttempt } from './use-async-attempt'
import { useIntegrationStatus } from './use-integration-status'
import { useSettings } from './use-settings'

export type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11

/** The final step celebrates completion; step 6 offers an account passkey. */
export const onboardingStepCount = 7

/** Keep persisted connected steps stable while inserting device-only setup. */
export const getOnboardingSteps = (isStandalone: boolean, hasBuiltInSearch = false): readonly OnboardingStep[] =>
  isStandalone ? (hasBuiltInSearch ? [1, 8, 9, 3, 5, 11, 7] : [1, 8, 9, 10, 3, 5, 11, 7]) : [1, 2, 3, 4, 5, 6, 11, 7]

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

type OnboardingData = {
  currentStep: OnboardingStep
  privacyAgreed: boolean
  isProviderConnected: boolean
  isConnecting: boolean
  processingOAuth: boolean
  nameValue: string
  isNameValid: boolean
  isSubmittingName: boolean
  locationValue: string
  isLocationValid: boolean
  isSubmittingLocation: boolean
}

export type OnboardingState = OnboardingData & { canGoBack: boolean; canGoNext: boolean; canSkip: boolean }

/** Navigation depends only on the active step and whether its data has been saved. */
export const selectOnboardingNavigation = (
  state: OnboardingData,
  steps: readonly OnboardingStep[] = getOnboardingSteps(false),
) => {
  const canContinue = () => {
    switch (state.currentStep) {
      case 1:
        return state.privacyAgreed
      case 2:
        return state.isProviderConnected && !state.isConnecting && !state.processingOAuth
      case 3:
        return state.isNameValid && !state.isSubmittingName
      case 4:
        return state.isLocationValid && !state.isSubmittingLocation
      case 5:
      case 6:
      case 8:
      case 9:
      case 10:
      case 11:
        return true
      case 7:
        return false
    }
  }
  return {
    canGoBack: steps.indexOf(state.currentStep) > 0,
    canGoNext: canContinue(),
    canSkip: steps.indexOf(state.currentStep) > 0 && state.currentStep !== onboardingStepCount,
  }
}

type LocationSelection = {
  locationName: string
  locationId: number
  locationLat: number
  locationLng: number
  locationCountryCode: string
}

type Draft = {
  currentStep: OnboardingStep | null
  privacyAgreed: boolean
  isProviderConnected: boolean | null
  isConnecting: boolean
  processingOAuth: boolean
  nameValue: string | null
  isSubmittingName: boolean
  location: { name: string; status: 'saving' | 'saved' | 'failed' } | null
}

type OnboardingAction =
  | { type: 'SET_CURRENT_STEP'; payload: OnboardingStep }
  | { type: 'SET_PRIVACY_AGREED'; payload: boolean }
  | { type: 'SET_PROVIDER_CONNECTED'; payload: boolean }
  | { type: 'SET_CONNECTING'; payload: boolean }
  | { type: 'SET_PROCESSING_OAUTH'; payload: boolean }
  | { type: 'SET_NAME_VALUE'; payload: string }
  | { type: 'SET_SUBMITTING_NAME'; payload: boolean }
  | { type: 'SAVE_LOCATION'; payload: string }
  | { type: 'LOCATION_SAVED' }
  | { type: 'LOCATION_FAILED' }

const initialState: Draft = {
  currentStep: null,
  privacyAgreed: false,
  isProviderConnected: null,
  isConnecting: false,
  processingOAuth: false,
  nameValue: null,
  isSubmittingName: false,
  location: null,
}

const onboardingReducer = (state: Draft, action: OnboardingAction): Draft => {
  switch (action.type) {
    case 'SET_CURRENT_STEP':
      return { ...state, currentStep: action.payload }
    case 'SET_PRIVACY_AGREED':
      return { ...state, privacyAgreed: action.payload }
    case 'SET_PROVIDER_CONNECTED':
      return { ...state, isProviderConnected: action.payload }
    case 'SET_CONNECTING':
      return { ...state, isConnecting: action.payload }
    case 'SET_PROCESSING_OAUTH':
      return { ...state, processingOAuth: action.payload }
    case 'SET_NAME_VALUE':
      return { ...state, nameValue: action.payload }
    case 'SET_SUBMITTING_NAME':
      return { ...state, isSubmittingName: action.payload }
    case 'SAVE_LOCATION':
      return { ...state, location: { name: action.payload, status: 'saving' } }
    case 'LOCATION_SAVED':
    case 'LOCATION_FAILED':
      return state.location
        ? { ...state, location: { ...state.location, status: action.type === 'LOCATION_SAVED' ? 'saved' : 'failed' } }
        : state
  }
}

/** Read a persisted wizard position, falling back to the first step for invalid settings. */
const parseOnboardingStep = (value: string): OnboardingStep => {
  const step = Number(value)
  return Number.isInteger(step) && step >= 1 && step <= 11 ? (step as OnboardingStep) : 1
}

/** Own draft fields and serialized writes; persisted values are defaults until the user edits them. */
export const useOnboardingState = ({
  isStandalone = false,
  hasBuiltInSearch = false,
}: { isStandalone?: boolean; hasBuiltInSearch?: boolean } = {}) => {
  const [draft, dispatch] = useReducer(onboardingReducer, initialState)
  const navigation = useAsyncAttempt()
  const nameSave = useAsyncAttempt()
  const locationSave = useAsyncAttempt()
  const db = useDatabase()
  const httpClient = useHttpClient()
  const locale = useActiveLocale()
  const { onboardingCurrentStep, preferredName, locationName, locationNameDisplay, locationLat, locationLng } =
    useSettings({
      onboarding_current_step: '1',
      preferred_name: '',
      location_name: '',
      location_name_display: '',
      location_lat: '',
      location_lng: '',
    })
  const { data: integrationStatusData } = useIntegrationStatus()
  const nameValue = draft.nameValue ?? preferredName.value
  const savedLocation = locationNameDisplay.value || locationName.value
  const hasSavedLocation = savedLocation.length > 0 && locationLat.value !== '' && locationLng.value !== ''
  const steps = getOnboardingSteps(isStandalone, hasBuiltInSearch)
  const currentStep = resolveOnboardingStep(
    draft.currentStep ?? parseOnboardingStep(onboardingCurrentStep.value),
    isStandalone,
    hasBuiltInSearch,
  )
  const stepIndex = steps.indexOf(currentStep)
  const current: OnboardingData = {
    currentStep,
    privacyAgreed: draft.privacyAgreed,
    isProviderConnected: draft.isProviderConnected ?? integrationStatusData?.googleConnected ?? false,
    isConnecting: draft.isConnecting,
    processingOAuth: draft.processingOAuth,
    nameValue,
    isNameValid: nameValue.trim().length > 0,
    isSubmittingName: draft.isSubmittingName,
    locationValue: draft.location?.name ?? savedLocation,
    isLocationValid: draft.location ? draft.location.status === 'saved' : hasSavedLocation,
    isSubmittingLocation: draft.location?.status === 'saving',
  }

  const navigate = async (direction: 'next' | 'back' | 'skip' | 'complete') => {
    const attempt = navigation.begin()
    if (!attempt) {
      return
    }
    try {
      if (direction === 'complete') {
        await updateSettings(db, { user_has_completed_onboarding: true, onboarding_current_step: '1' })
        return
      }
      if (direction === 'next' && current.currentStep === 3) {
        await actions.submitName(current.nameValue)
      }
      if (!attempt.isCurrent()) {
        return
      }
      const step = steps[Math.max(0, Math.min(stepIndex + (direction === 'back' ? -1 : 1), steps.length - 1))]
      const clearName = direction === 'skip' && current.currentStep === 3
      // Skipping the name and advancing are one persisted operation.
      await updateSettings(db, {
        onboarding_current_step: String(step),
        ...(clearName ? { preferred_name: '' } : {}),
      })
      if (attempt.isCurrent()) {
        if (clearName) {
          dispatch({ type: 'SET_NAME_VALUE', payload: '' })
        }
        dispatch({ type: 'SET_CURRENT_STEP', payload: step })
      }
    } finally {
      attempt.finish()
    }
  }

  const actions = {
    setCurrentStep: (step: OnboardingStep) => dispatch({ type: 'SET_CURRENT_STEP', payload: step }),
    setPrivacyAgreed: (agreed: boolean) => dispatch({ type: 'SET_PRIVACY_AGREED', payload: agreed }),
    setProviderConnected: (connected: boolean) => dispatch({ type: 'SET_PROVIDER_CONNECTED', payload: connected }),
    setConnecting: (connecting: boolean) => dispatch({ type: 'SET_CONNECTING', payload: connecting }),
    setProcessingOAuth: (processing: boolean) => dispatch({ type: 'SET_PROCESSING_OAUTH', payload: processing }),
    setNameValue: (value: string) => dispatch({ type: 'SET_NAME_VALUE', payload: value }),

    submitName: async (name: string) => {
      const attempt = nameSave.begin()
      if (!attempt) {
        return
      }
      dispatch({ type: 'SET_NAME_VALUE', payload: name })
      dispatch({ type: 'SET_SUBMITTING_NAME', payload: true })
      try {
        await preferredName.setValue(name)
      } finally {
        if (attempt.isCurrent()) {
          dispatch({ type: 'SET_SUBMITTING_NAME', payload: false })
        }
        attempt.finish()
      }
    },

    submitLocation: async (location: LocationSelection) => {
      const attempt = locationSave.begin()
      if (!attempt) {
        return
      }
      dispatch({ type: 'SAVE_LOCATION', payload: location.locationName })
      try {
        const englishName = await fetchEnglishLocationName(
          httpClient,
          location.locationId,
          location.locationName,
          locale,
        )
        if (!attempt.isCurrent()) {
          return
        }
        await updateSettings(db, {
          location_name: englishName,
          location_lat: String(location.locationLat),
          location_lng: String(location.locationLng),
          location_country_code: location.locationCountryCode,
          location_id: String(location.locationId),
          location_name_display: location.locationName,
        })
        // Location-derived units remain seeded defaults, not explicit user edits.
        if (location.locationCountryCode && attempt.isCurrent()) {
          const units = unitDefaultsForRegion(location.locationCountryCode)
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
        if (attempt.isCurrent()) {
          dispatch({ type: 'LOCATION_SAVED' })
        }
      } catch (error) {
        if (attempt.isCurrent()) {
          dispatch({ type: 'LOCATION_FAILED' })
        }
        throw error
      } finally {
        attempt.finish()
      }
    },

    nextStep: () => navigate('next'),
    prevStep: () => navigate('back'),
    skipStep: () => navigate('skip'),
    completeOnboarding: () => navigate('complete'),
  }

  return {
    state: { ...current, ...selectOnboardingNavigation(current, steps) },
    actions,
    stepIndex,
    totalSteps: steps.length,
  }
}

export type { OnboardingAction }
