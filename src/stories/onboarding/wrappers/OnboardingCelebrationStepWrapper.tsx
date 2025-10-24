import { OnboardingCelebrationStep } from '@/components/onboarding/onboarding-celebration-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'

export const OnboardingCelebrationStepWrapper = () => {
  return (
    <div className="w-[400px] h-[500px] border rounded-lg p-4">
      {createQueryTestWrapper()({
        children: <OnboardingCelebrationStep />,
      })}
    </div>
  )
}
