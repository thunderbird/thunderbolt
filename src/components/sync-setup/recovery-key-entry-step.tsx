import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type RecoveryKeyEntryStepProps = {
  value: string
  error: string | null
  onChange: (value: string) => void
  onSubmit: () => void
  onBack: () => void
}

export const RecoveryKeyEntryStep = ({
  value,
  error,
  onChange,
  onSubmit,
  onBack,
}: RecoveryKeyEntryStepProps) => {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onSubmit()
    }
  }

  return (
    <div className="flex flex-col flex-1">
      <div className="flex-1 flex flex-col justify-center gap-6">
        <div className="text-center">
          <h2 className="text-lg font-semibold">Enter recovery key</h2>
          <p className="text-sm text-muted-foreground mt-2">
            Enter the 64-character recovery key you saved when you first set up sync.
          </p>
        </div>

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
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <button
          type="button"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline text-center"
          onClick={onBack}
        >
          Go back
        </button>
      </div>

      <div className="pt-6">
        <Button className="w-full" onClick={onSubmit}>
          Submit
        </Button>
      </div>
    </div>
  )
}
