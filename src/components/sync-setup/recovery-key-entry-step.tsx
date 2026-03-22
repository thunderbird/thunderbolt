import { type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type RecoveryKeyEntryStepProps = {
  value: string
  error: string | null
  onChange: (value: string) => void
  onSubmit: () => void
}

export const RecoveryKeyEntryStep = ({ value, error, onChange, onSubmit }: RecoveryKeyEntryStepProps) => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      onSubmit()
    }
  }

  return (
    <div className="w-full flex flex-col">
      <div className="text-center space-y-4">
        <h2 className="text-2xl font-bold">Enter recovery key</h2>
        <p className="text-muted-foreground">
          Enter the 64-character recovery key you saved when you first set up sync.
        </p>
      </div>

      <div className="pt-5 space-y-4">
        <div className="flex flex-col gap-2">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="a1b2c3d4e5f6a7b8..."
            className="font-mono"
            state={error ? 'error' : 'default'}
            autoFocus
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <Button className="w-full" onClick={onSubmit}>
          Submit
        </Button>
      </div>
    </div>
  )
}
