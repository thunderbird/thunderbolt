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
  <div className="flex flex-col flex-1">
    <div className="flex-1 flex flex-col justify-center gap-6">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Approve this device</h2>
        <p className="text-sm text-muted-foreground mt-2">
          Open Thunderbolt on one of your trusted devices and go to Settings &rarr; Devices to approve this device.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <Checkbox checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} className="mt-0.5" />
          <span className="text-sm">I have approved this device on another device</span>
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <button
        type="button"
        className="text-sm text-primary underline-offset-4 hover:underline text-center"
        onClick={onUseRecoveryKey}
      >
        Don&apos;t have another device? Use recovery key instead
      </button>
    </div>

    <div className="pt-6">
      <Button className="w-full" onClick={onContinue} disabled={!checked}>
        Continue
      </Button>
    </div>
  </div>
)
