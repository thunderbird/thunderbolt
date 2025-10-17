import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Shield, Lock, Eye, Database } from 'lucide-react'

type OnboardingStep1Props = {
  onNext: () => void
}

export default function OnboardingStep1({ onNext }: OnboardingStep1Props) {
  const [agreedToTerms, setAgreedToTerms] = useState(false)

  return (
    <div className="space-y-6">
      <div className="text-center space-y-4">
        <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
          <Shield className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-2xl font-bold">Privacy & Security First</h2>
        <p className="text-muted-foreground">Your privacy is our priority. Here's how we protect your data.</p>
      </div>

      <div className="space-y-4">
        <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/50">
          <Lock className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-medium">On-Device Processing</h3>
            <p className="text-sm text-muted-foreground">
              Your conversations and data are processed locally on your device, not sent to external servers.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/50">
          <Eye className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-medium">No Data Collection</h3>
            <p className="text-sm text-muted-foreground">
              We don't collect, store, or share your personal information with third parties.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/50">
          <Database className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-medium">Local Storage</h3>
            <p className="text-sm text-muted-foreground">
              All your data is stored securely on your device using industry-standard encryption.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <Checkbox
            id="terms-agreement"
            checked={agreedToTerms}
            onCheckedChange={(checked) => setAgreedToTerms(checked === true)}
            className="mt-1"
          />
          <label htmlFor="terms-agreement" className="text-sm text-muted-foreground">
            I agree to the{' '}
            <a
              href="https://www.thunderbird.net/en-US/privacy/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline hover:no-underline"
            >
              Privacy Policy
            </a>{' '}
            and understand how my data is handled.
          </label>
        </div>
      </div>

      <div className="pt-4">
        <Button onClick={onNext} className="w-full" disabled={!agreedToTerms}>
          I Agree & Continue
        </Button>
      </div>
    </div>
  )
}
