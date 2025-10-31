import { OnboardingLocationStep } from '@/components/onboarding/onboarding-location-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import type { OnboardingState } from '@/hooks/use-onboarding-state'

export const OnboardingLocationStepWrapper = () => {
  const mockState: OnboardingState = {
    currentStep: 4 as const,
    privacyAgreed: true,
    isProviderConnected: true,
    isConnecting: false,
    processingOAuth: false,
    nameValue: 'John Doe',
    isNameValid: true,
    isSubmittingName: false,
    locationValue: '',
    isLocationValid: false,
    isSubmittingLocation: false,
    canGoBack: true,
    canGoNext: false,
    canSkip: true,
  }

  const mockActions = {
    setLocationValue: (value: string) => console.log('setLocationValue:', value),
    setLocationValid: (valid: boolean) => console.log('setLocationValid:', valid),
    setSubmittingLocation: (submitting: boolean) => console.log('setSubmittingLocation:', submitting),
    submitLocation: async (locationData: { locationName: string; locationLat: number; locationLng: number }) => {
      console.log('submitLocation:', locationData)
    },
    nextStep: async () => console.log('nextStep'),
    prevStep: async () => console.log('prevStep'),
    skipStep: async () => console.log('skipStep'),
  }

  return (
    <div className="w-[400px] h-[500px] border rounded-lg p-4">
      {createQueryTestWrapper()({
        children: <OnboardingLocationStep state={mockState} actions={mockActions} />,
      })}
    </div>
  )
}
