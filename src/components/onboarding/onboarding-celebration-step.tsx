import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { CheckCircle, Sparkles } from 'lucide-react'
import { useSettings } from '@/hooks/use-settings'

type OnboardingCelebrationStepProps = {
  onComplete: () => void
}

export const OnboardingCelebrationStep = ({ onComplete }: OnboardingCelebrationStepProps) => {
  const [isCompleting, setIsCompleting] = useState(false)
  const { userHasCompletedOnboarding, onboardingCurrentStep } = useSettings({
    user_has_completed_onboarding: false,
    onboarding_current_step: '1',
  })

  const handleComplete = async () => {
    setIsCompleting(true)
    // Mark onboarding as completed and reset step
    await Promise.all([userHasCompletedOnboarding.setValue(true), onboardingCurrentStep.setValue('1')])
    setIsCompleting(false)
    onComplete()
  }

  return (
    <div className="w-full h-full flex flex-col justify-center">
      <div className="space-y-6 text-center">
        <div className="space-y-4">
          <div className="mx-auto w-16 h-16 bg-green-100 dark:bg-green-900/20 rounded-full flex items-center justify-center">
            <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-bold text-green-600 dark:text-green-400">All Set!</h2>
            <p className="text-lg text-muted-foreground">Welcome to Thunderbolt! 🎉</p>
          </div>
        </div>

        <div className="sm:space-y-6 max-w-md mx-auto pt-3">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
            <Sparkles className="w-5 h-5 flex-shrink-0" />
            <div>
              <h3 className="font-medium text-sm">You're Ready to Go!</h3>
              <p className="text-xs text-muted-foreground">
                Your AI assistant is configured and ready to help you with tasks, answer questions, and make your
                workflow more efficient.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
            <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0" />
            <div>
              <h3 className="font-medium text-sm">Privacy Protected</h3>
              <p className="text-xs text-muted-foreground">
                All your data stays on your device. No cloud storage, no data collection - just secure, local AI
                assistance.
              </p>
            </div>
          </div>
        </div>
      </div>
      <div className="pt-5">
        <Button onClick={handleComplete} className="w-full" size="lg" disabled={isCompleting}>
          {isCompleting ? 'Completing...' : 'Start Using Thunderbolt'}
        </Button>
      </div>
    </div>
  )
}
