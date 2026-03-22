import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

type ApprovalWaitingStepProps = {
  checked: boolean
  error: string | null
  onCheckedChange: (checked: boolean) => void
  onContinue: () => void
  onUseRecoveryKey: () => void
}

export const ApprovalWaitingStep = ({
  checked,
  error,
  onCheckedChange,
  onContinue,
  onUseRecoveryKey,
}: ApprovalWaitingStepProps) => (
  <div className="w-full flex flex-col">
    <div className="text-center space-y-4">
      <h2 className="text-2xl font-bold">Approve this device</h2>
      <p className="text-muted-foreground">
        Open Thunderbolt on one of your trusted devices and go to Settings &rarr; Devices to approve this device.
      </p>
    </div>

    <div className="pt-5 space-y-4">
      <label className="flex items-start gap-3 cursor-pointer">
        <Checkbox checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} className="mt-0.5" />
        <span className="text-sm">I have approved this device on another device</span>
      </label>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <button
        type="button"
        className="text-sm text-primary underline-offset-4 hover:underline text-center w-full"
        onClick={onUseRecoveryKey}
      >
        Don&apos;t have another device? Use recovery key instead
      </button>

      <Button className="w-full" onClick={onContinue} disabled={!checked}>
        Continue
      </Button>
    </div>
  </div>
)
