import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'

type ImportPassphraseStepProps = {
  isVerifying: boolean
  onVerify: () => void
  onSetPassphrase: (passphrase: string) => void
}

export const ImportPassphraseStep = ({ isVerifying, onVerify, onSetPassphrase }: ImportPassphraseStepProps) => {
  const [passphrase, setPassphrase] = useState('')

  const handleSubmit = () => {
    onSetPassphrase(passphrase)
    onVerify()
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Enter the passphrase you used when creating your encryption key on another device. Your key will be re-derived
        from this passphrase.
      </p>

      <Input
        type="password"
        placeholder="Enter your passphrase"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        disabled={isVerifying}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && passphrase.trim().length > 0) {
            handleSubmit()
          }
        }}
      />

      <Button disabled={passphrase.trim().length === 0 || isVerifying} onClick={handleSubmit}>
        {isVerifying ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Verifying...
          </>
        ) : (
          'Verify & Import'
        )}
      </Button>
    </div>
  )
}
