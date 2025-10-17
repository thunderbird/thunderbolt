import { Button } from '@/components/ui/button'

type OnboardingStep2Props = {
  onBack: () => void
  onClose: () => void
}

export default function OnboardingStep2({ onBack, onClose }: OnboardingStep2Props) {
  return (
    <div className="space-y-6">
      <div className="text-center space-y-4">
        <h2 className="text-2xl font-bold">Setup Complete</h2>
        <p className="text-muted-foreground">
          You're ready to start using Thunderbolt! Here are some tips to help you get started.
        </p>
      </div>

      <div className="space-y-4">
        <div className="p-4 rounded-lg bg-muted/50 space-y-2">
          <h3 className="font-medium flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary"></span>
            Start a Conversation
          </h3>
          <p className="text-sm text-muted-foreground">
            Click "New Chat" to begin talking with your AI assistant. Try asking about your emails, calendar, or any
            task you need help with.
          </p>
        </div>

        <div className="p-4 rounded-lg bg-muted/50 space-y-2">
          <h3 className="font-medium flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary"></span>
            Explore Settings
          </h3>
          <p className="text-sm text-muted-foreground">
            Visit Settings to connect integrations, configure preferences, and customize your experience.
          </p>
        </div>

        <div className="p-4 rounded-lg bg-muted/50 space-y-2">
          <h3 className="font-medium flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary"></span>
            Try Automations
          </h3>
          <p className="text-sm text-muted-foreground">
            Set up automated tasks that run on schedule or trigger based on your needs.
          </p>
        </div>
      </div>

      <div className="flex gap-3 pt-4">
        <Button variant="outline" onClick={onBack} className="flex-1">
          Back
        </Button>
        <Button onClick={onClose} className="flex-1">
          Start Using Thunderbolt
        </Button>
      </div>
    </div>
  )
}
