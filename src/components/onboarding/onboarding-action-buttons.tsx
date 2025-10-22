import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'

type OnboardingActionButtonsProps = {
  onBack: () => void
  onSkip: () => void
}

export const OnboardingActionButtons = ({ onBack, onSkip }: OnboardingActionButtonsProps) => {
  return (
    <div className="flex items-center justify-between w-full">
      <div>
        <Button onClick={onBack} variant="ghost" size="sm" className="p-2">
          <ArrowLeft className="w-4 h-4" />
        </Button>
      </div>
      <div className="flex items-center gap-2 sm:gap-3">
        <Button onClick={onSkip} variant="ghost" size="sm" className="text-xs sm:text-sm">
          Skip
        </Button>
      </div>
    </div>
  )
}
