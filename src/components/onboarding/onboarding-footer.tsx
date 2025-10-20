import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'

type OnboardingFooterProps = {
  onBack?: () => void
  onSkip?: () => void
  onContinue: () => void
  continueText?: string
  continueDisabled?: boolean
  showBack?: boolean
  showSkip?: boolean
}

export const OnboardingFooter = ({
  onBack,
  onSkip,
  onContinue,
  continueText = 'Continue',
  continueDisabled = false,
  showBack = true,
  showSkip = true,
}: OnboardingFooterProps) => {
  return (
    <div className="flex items-center justify-between pt-6 py-1">
      <div>
        {showBack && onBack && (
          <Button onClick={onBack} variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
        )}
      </div>

      <div className="flex items-center gap-3">
        {showSkip && onSkip && (
          <Button onClick={onSkip} variant="ghost" size="sm" disabled={continueDisabled}>
            Skip
          </Button>
        )}
        <Button onClick={onContinue} disabled={continueDisabled}>
          {continueText}
        </Button>
      </div>
    </div>
  )
}
