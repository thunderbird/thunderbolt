import { Button } from '@/components/ui/button'
import { Mail, Calendar, HardDrive } from 'lucide-react'

type OnboardingStep2Props = {
  onNext: () => void
  onSkip: () => void
  onBack: () => void
}

export default function OnboardingStep2({ onNext, onSkip, onBack }: OnboardingStep2Props) {
  return (
    <div className="space-y-6">
      <div className="text-center space-y-4">
        <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
          <Mail className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-2xl font-bold">Connect Google Account</h2>
        <p className="text-muted-foreground">
          Connect your Google account to access your calendar, email, and drive files.
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/50">
          <Calendar className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-medium">Calendar Access</h3>
            <p className="text-sm text-muted-foreground">
              View and manage your schedule, create events, and get smart reminders.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/50">
          <Mail className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-medium">Email Integration</h3>
            <p className="text-sm text-muted-foreground">
              Read, compose, and organize your emails with AI-powered assistance.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/50">
          <HardDrive className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-medium">Drive Access</h3>
            <p className="text-sm text-muted-foreground">Search and work with your Google Drive files and documents.</p>
          </div>
        </div>
      </div>

      <div className="space-y-3 pt-4">
        <Button onClick={onNext} className="w-full">
          Connect Google Account
        </Button>
        <Button onClick={onSkip} variant="outline" className="w-full">
          Skip for Now
        </Button>
        <Button onClick={onBack} variant="ghost" className="w-full">
          Back
        </Button>
      </div>
    </div>
  )
}
