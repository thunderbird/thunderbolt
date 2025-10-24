import { OnboardingNameStep } from '@/components/onboarding/onboarding-name-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import type { OnboardingState } from '@/hooks/use-onboarding-state'

export const OnboardingNameStepWrapper = () => {
  const mockState: OnboardingState = {
    currentStep: 3 as const,
    privacyAgreed: true,
    isProviderConnected: true,
    isConnecting: false,
    processingOAuth: false,
    nameValue: '',
    isNameValid: false,
    isSubmittingName: false,
    locationValue: '',
    isLocationValid: false,
    isSubmittingLocation: false,
    canGoBack: true,
    canGoNext: false,
    canSkip: false,
  }

  const mockActions = {
    setNameValue: (value: string) => console.log('setNameValue:', value),
    setNameValid: (valid: boolean) => console.log('setNameValid:', valid),
    setSubmittingName: (submitting: boolean) => console.log('setSubmittingName:', submitting),
    submitName: async (name: string) => {
      console.log('submitName:', name)
    },
    nextStep: async () => console.log('nextStep'),
    prevStep: async () => console.log('prevStep'),
    skipStep: async () => console.log('skipStep'),
  }

  return (
    <div className="w-[400px] h-[500px] border rounded-lg p-4">
      {createQueryTestWrapper()({
        children: <OnboardingNameStep state={mockState} actions={mockActions} />,
      })}
    </div>
  )
}
