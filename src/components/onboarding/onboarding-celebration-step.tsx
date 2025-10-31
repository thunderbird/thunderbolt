import { CheckCircle } from 'lucide-react'
import { IconCircle } from './icon-circle'

export const OnboardingCelebrationStep = () => {
  return (
    <div className="w-full h-full flex flex-col justify-center">
      <div className="space-y-6">
        <div className="space-y-4 text-center">
          <IconCircle>
            <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
          </IconCircle>
          <div className="space-y-2">
            <p className="text-lg text-muted-foreground">You're all set! 🎉</p>
          </div>
        </div>
      </div>
    </div>
  )
}
