/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as dal from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { settingsTable } from '@/db/tables'
import { eq } from 'drizzle-orm'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { useQueryClient } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import {
  selectOnboardingNavigation,
  useOnboardingState,
  getOnboardingSteps,
  resolveOnboardingStep,
  type OnboardingState,
} from './use-onboarding-state'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(resetTestDatabase)

const flush = () =>
  act(async () => {
    await getClock().runAllAsync()
  })
const mount = () =>
  renderHook(() => ({ ...useOnboardingState(), queryClient: useQueryClient() }), {
    wrapper: createTestProvider(),
  })
const stored = async (key: string) => {
  const rows = await getDb().select().from(settingsTable).where(eq(settingsTable.key, key))
  return rows[0]?.value
}
const location = {
  locationName: 'Paris, France',
  locationId: 2988507,
  locationLat: 48.8566,
  locationLng: 2.3522,
  locationCountryCode: 'FR',
}

describe('onboarding drafts', () => {
  it('starts on privacy with no valid fields', () => {
    const { result } = mount()
    expect(result.current.state).toMatchObject({
      currentStep: 1,
      privacyAgreed: false,
      nameValue: '',
      isNameValid: false,
      locationValue: '',
      isLocationValid: false,
      canGoBack: false,
      canGoNext: false,
      canSkip: false,
    })
  })

  it('loads saved step and name without overwriting later edits or navigation', async () => {
    await dal.updateSettings(getDb(), { onboarding_current_step: '3', preferred_name: 'Saved' })
    const { result } = mount()
    await flush()
    expect(result.current.state.currentStep).toBe(3)
    expect(result.current.state.nameValue).toBe('Saved')
    act(() => {
      result.current.actions.setNameValue('Edited')
      result.current.actions.setCurrentStep(4)
    })
    await dal.updateSettings(getDb(), { onboarding_current_step: '2', preferred_name: 'Remote' })
    await act(() => result.current.queryClient.invalidateQueries())
    await flush()
    expect(result.current.state.currentStep).toBe(4)
    expect(result.current.state.nameValue).toBe('Edited')
  })

  it.each(['Paris localisé', ''])(
    'restores a saved location with display name %j and accepts zero coordinates',
    async (display) => {
      await dal.updateSettings(getDb(), {
        onboarding_current_step: '4',
        location_name: 'Paris',
        location_name_display: display,
        location_lat: '0',
        location_lng: '0',
      })
      const { result } = mount()
      await flush()
      expect(result.current.state.locationValue).toBe(display || 'Paris')
      expect(result.current.state.isLocationValid).toBe(true)
      expect(result.current.state.canGoNext).toBe(true)
    },
  )

  it('does not enable Continue for a saved location without coordinates', async () => {
    await dal.updateSettings(getDb(), { onboarding_current_step: '4', location_name: 'Paris', location_lat: '0' })
    const { result } = mount()
    await flush()
    expect(result.current.state.isLocationValid).toBe(false)
    expect(result.current.state.canGoNext).toBe(false)
  })

  it.each(['0', '12', '2.5', '3invalid', ''])('rejects invalid saved step %s', async (step) => {
    await dal.updateSettings(getDb(), { onboarding_current_step: step })
    const { result } = mount()
    await flush()
    expect(result.current.state.currentStep).toBe(1)
  })

  it('does not let a late saved name overwrite an edit made before loading', async () => {
    await dal.updateSettings(getDb(), { preferred_name: 'Saved' })
    const { result } = mount()
    act(() => result.current.actions.setNameValue(''))
    await flush()
    expect(result.current.state.nameValue).toBe('')
    expect(result.current.state.isNameValid).toBe(false)
  })

  it('keeps provider navigation blocked during connection and OAuth processing', () => {
    const { result } = mount()
    act(() => {
      result.current.actions.setCurrentStep(2)
      result.current.actions.setProviderConnected(true)
    })
    expect(result.current.state.canGoNext).toBe(true)
    act(() => result.current.actions.setConnecting(true))
    expect(result.current.state.canGoNext).toBe(false)
    act(() => {
      result.current.actions.setConnecting(false)
      result.current.actions.setProcessingOAuth(true)
    })
    expect(result.current.state.canGoNext).toBe(false)
    act(() => result.current.actions.setProcessingOAuth(false))
    expect(result.current.state.canGoNext).toBe(true)
    act(() => result.current.actions.setProviderConnected(false))
    expect(result.current.state.canGoNext).toBe(false)
  })

  it('derives name validity and never enables another step from a field edit', () => {
    const { result } = mount()
    act(() => result.current.actions.setNameValue('Alice'))
    expect(result.current.state.canGoNext).toBe(false)
    act(() => result.current.actions.setCurrentStep(3))
    expect(result.current.state.canGoNext).toBe(true)
    act(() => result.current.actions.setNameValue('  '))
    expect(result.current.state.nameValue).toBe('  ')
    expect(result.current.state.canGoNext).toBe(false)
    act(() => {
      result.current.actions.setCurrentStep(7)
      result.current.actions.setProviderConnected(true)
    })
    expect(result.current.state.canGoNext).toBe(false)
  })
})

describe('onboarding persistence', () => {
  it('saves a name and releases pending state on a failed save so it can be retried', async () => {
    const { result } = mount()
    await flush()
    act(() => result.current.actions.setCurrentStep(3))
    const write = spyOn(dal, 'updateSettings').mockRejectedValueOnce(new Error('disk full'))
    try {
      await act(async () => {
        await expect(result.current.actions.submitName('Alice')).rejects.toThrow('disk full')
      })
    } finally {
      write.mockRestore()
    }
    expect(result.current.state).toMatchObject({ nameValue: 'Alice', isNameValid: true, isSubmittingName: false })
    await act(() => result.current.actions.submitName('Alice'))
    expect(await stored('preferred_name')).toBe('Alice')
  })

  it('admits one name save and keeps Continue blocked until it finishes', async () => {
    const { result } = mount()
    await flush()
    act(() => result.current.actions.setCurrentStep(3))
    const pending = Promise.withResolvers<void>()
    const write = spyOn(dal, 'updateSettings').mockImplementation(() => pending.promise)
    try {
      const runs: Promise<void>[] = []
      act(() => {
        runs.push(result.current.actions.submitName('Alice'), result.current.actions.submitName('Bob'))
      })
      expect(result.current.state.canGoNext).toBe(false)
      await act(async () => {
        pending.resolve()
        await Promise.all(runs)
      })
      expect(write).toHaveBeenCalledTimes(1)
      expect(result.current.state.nameValue).toBe('Alice')
      expect(result.current.state.canGoNext).toBe(true)
    } finally {
      write.mockRestore()
    }
  })

  it('saves location and region defaults before enabling Continue, retaining selection on revisit', async () => {
    const { result } = mount()
    act(() => result.current.actions.setCurrentStep(4))
    await act(() => result.current.actions.submitLocation(location))
    expect(result.current.state).toMatchObject({
      locationValue: location.locationName,
      isLocationValid: true,
      isSubmittingLocation: false,
      canGoNext: true,
    })
    expect(await stored('location_country_code')).toBe('FR')
    expect(await stored('currency')).toBe('EUR')
    act(() => result.current.actions.setCurrentStep(5))
    await act(() => result.current.actions.prevStep())
    expect(result.current.state.locationValue).toBe(location.locationName)
  })

  it('accepts zero coordinates and locations with no country code', async () => {
    const { result } = mount()
    await act(() =>
      result.current.actions.submitLocation({ ...location, locationLat: 0, locationLng: 0, locationCountryCode: '' }),
    )
    expect(result.current.state.isLocationValid).toBe(true)
    expect(await stored('location_lat')).toBe('0')
    expect(await stored('location_lng')).toBe('0')
    expect(await stored('currency')).toBeUndefined()
  })

  it.each([1, 2])('a failed location write %s blocks Continue and can be retried', async (failure) => {
    const { result } = mount()
    await flush()
    act(() => result.current.actions.setCurrentStep(4))
    const original = dal.updateSettings
    const write = spyOn(dal, 'updateSettings')
    if (failure === 2) {
      write.mockImplementationOnce(original)
    }
    write.mockRejectedValueOnce(new Error('disk full'))
    try {
      await act(async () => {
        await expect(result.current.actions.submitLocation(location)).rejects.toThrow('disk full')
      })
    } finally {
      write.mockRestore()
    }
    expect(result.current.state).toMatchObject({
      isLocationValid: false,
      isSubmittingLocation: false,
      canGoNext: false,
    })
    await act(() => result.current.actions.submitLocation(location))
    expect(result.current.state.canGoNext).toBe(true)
  })

  it('admits one location write while the picker is saving', async () => {
    const { result } = mount()
    await flush()
    const pending = Promise.withResolvers<void>()
    const write = spyOn(dal, 'updateSettings').mockImplementation(() => pending.promise)
    try {
      const runs: Promise<void>[] = []
      act(() => {
        runs.push(
          result.current.actions.submitLocation(location),
          result.current.actions.submitLocation({ ...location, locationName: 'Other' }),
        )
      })
      expect(result.current.state.isSubmittingLocation).toBe(true)
      await act(async () => {
        pending.resolve()
        await Promise.all(runs)
      })
      expect(write).toHaveBeenCalledTimes(2)
      expect(result.current.state.locationValue).toBe(location.locationName)
    } finally {
      write.mockRestore()
    }
  })

  it('persists exactly one advance when Continue is invoked twice before rendering', async () => {
    const { result } = mount()
    await act(async () => {
      await Promise.all([result.current.actions.nextStep(), result.current.actions.nextStep()])
    })
    expect(result.current.state.currentStep).toBe(2)
    expect(await stored('onboarding_current_step')).toBe('2')
  })

  it('leaves navigation at its original step when persistence fails', async () => {
    const { result } = mount()
    await flush()
    act(() => result.current.actions.setCurrentStep(3))
    const write = spyOn(dal, 'updateSettings').mockRejectedValueOnce(new Error('disk full'))
    try {
      await act(async () => {
        await expect(result.current.actions.nextStep()).rejects.toThrow('disk full')
      })
    } finally {
      write.mockRestore()
    }
    expect(result.current.state.currentStep).toBe(3)
    await act(() => result.current.actions.nextStep())
    expect(result.current.state.currentStep).toBe(4)
  })

  it('skips the name and persists the destination in one write', async () => {
    const { result } = mount()
    act(() => {
      result.current.actions.setCurrentStep(3)
      result.current.actions.setNameValue('Alice')
    })
    await act(() => result.current.actions.skipStep())
    expect(result.current.state).toMatchObject({ currentStep: 4, nameValue: '', isNameValid: false })
    expect(await stored('preferred_name')).toBe('')
    expect(await stored('onboarding_current_step')).toBe('4')
  })

  it('does not skip the name if the combined clear-and-advance write fails', async () => {
    const { result } = mount()
    await flush()
    act(() => {
      result.current.actions.setCurrentStep(3)
      result.current.actions.setNameValue('Alice')
    })
    const write = spyOn(dal, 'updateSettings').mockRejectedValueOnce(new Error('disk full'))
    try {
      await act(async () => {
        await expect(result.current.actions.skipStep()).rejects.toThrow('disk full')
      })
      expect(write).toHaveBeenCalledTimes(1)
      expect(write.mock.calls[0][1]).toEqual({ onboarding_current_step: '4', preferred_name: '' })
      expect(result.current.state).toMatchObject({ currentStep: 3, nameValue: 'Alice' })
    } finally {
      write.mockRestore()
    }
  })

  it('clamps navigation at both boundaries', async () => {
    const { result } = mount()
    await act(() => result.current.actions.prevStep())
    expect(result.current.state.currentStep).toBe(1)
    act(() => result.current.actions.setCurrentStep(7))
    await act(() => result.current.actions.nextStep())
    expect(result.current.state.currentStep).toBe(7)
    await act(() => result.current.actions.skipStep())
    expect(result.current.state.currentStep).toBe(7)
  })
})

describe('navigation selector', () => {
  const base: OnboardingState = {
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
    canGoNext: false,
    canSkip: false,
  }
  it.each([
    [{ currentStep: 1 }, false],
    [{ currentStep: 1, privacyAgreed: true }, true],
    [{ currentStep: 2 }, false],
    [{ currentStep: 2, isProviderConnected: true }, true],
    [{ currentStep: 2, isProviderConnected: true, isConnecting: true }, false],
    [{ currentStep: 2, isProviderConnected: true, processingOAuth: true }, false],
    [{ currentStep: 3, isNameValid: true }, true],
    [{ currentStep: 3, isNameValid: true, isSubmittingName: true }, false],
    [{ currentStep: 4, isLocationValid: true }, true],
    [{ currentStep: 4, isLocationValid: true, isSubmittingLocation: true }, false],
    [{ currentStep: 5 }, true],
    [{ currentStep: 6 }, true],
    [{ currentStep: 7 }, false],
  ] satisfies Array<[Partial<OnboardingState>, boolean]>)('evaluates the current step %j', (patch, expected) => {
    expect(selectOnboardingNavigation({ ...base, ...patch }).canGoNext).toBe(expected)
  })
})

describe('standalone flow', () => {
  it('keeps connected step identities and excludes server-only setup from the standalone path', () => {
    expect(getOnboardingSteps(false)).toEqual([1, 2, 3, 4, 5, 6, 11, 7])
    expect(getOnboardingSteps(true)).toEqual([1, 8, 9, 10, 3, 5, 11, 7])
    expect(getOnboardingSteps(true, true)).toEqual([1, 8, 9, 3, 5, 11, 7])
    expect(getOnboardingSteps(false, true)).toEqual([1, 2, 3, 4, 5, 6, 11, 7])
    expect(resolveOnboardingStep(10, true, true)).toBe(3)
    expect(resolveOnboardingStep(8, false)).toBe(2)
    expect(resolveOnboardingStep(4, true)).toBe(8)
  })

  it('offers server selection and permits skipping AI and search setup', async () => {
    const { result } = renderHook(() => useOnboardingState({ isStandalone: true }), {
      wrapper: createTestProvider(),
    })
    await act(async () => {
      await result.current.actions.nextStep()
    })
    expect(result.current.state.currentStep).toBe(8)
    await act(async () => {
      await result.current.actions.skipStep()
    })
    expect(result.current.state.currentStep).toBe(9)
    expect(result.current.state.canSkip).toBe(true)
    await act(async () => {
      await result.current.actions.skipStep()
    })
    expect(result.current.state.currentStep).toBe(10)
    expect(result.current.state.canSkip).toBe(true)
    await act(async () => {
      await result.current.actions.skipStep()
    })
    expect(result.current.state.currentStep).toBe(3)
    await act(async () => {
      await result.current.actions.prevStep()
    })
    expect(result.current.state.currentStep).toBe(10)
  })
})
