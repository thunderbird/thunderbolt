import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'

type CreatePassphraseStepProps = {
  isVerifying: boolean
  error: string | null
  onSubmitPassphrase: (passphrase: string) => void
  onSkip: () => void
}

export const CreatePassphraseStep = ({ isVerifying, error, onSubmitPassphrase, onSkip }: CreatePassphraseStepProps) => {
  const [passphrase, setPassphrase] = useState('')

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Optionally enter a passphrase to derive your encryption key. This lets you re-create the same key on other
        devices using just the passphrase.
      </p>
      <p className="text-sm text-muted-foreground">
        If you skip this step, a random key will be generated and your recovery key will be the only way to restore
        access.
      </p>
      <Input
        type="password"
        placeholder="Enter a passphrase (optional)"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        disabled={isVerifying}
        autoFocus
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onSkip} disabled={isVerifying}>
          {isVerifying ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Skip (random key)'}
        </Button>
        <Button
          className="flex-1"
          disabled={passphrase.trim().length === 0 || isVerifying}
          onClick={() => onSubmitPassphrase(passphrase)}
        >
          {isVerifying ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating...
            </>
          ) : (
            'Use passphrase'
          )}
        </Button>
      </div>
    </div>
  )
}
