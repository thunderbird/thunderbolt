import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Copy, Check } from 'lucide-react'
import { useState } from 'react'

type RecoveryKeyDisplayStepProps = {
  recoveryKey: string
  onDone: () => void
  onConfirmedChange: (confirmed: boolean) => void
}

/** Formats a 64-char hex string into 8-char groups separated by spaces */
const formatRecoveryKey = (key: string): string => key.match(/.{1,8}/g)?.join(' ') ?? key

export const RecoveryKeyDisplayStep = ({ recoveryKey, onDone, onConfirmedChange }: RecoveryKeyDisplayStepProps) => {
  const [copied, setCopied] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(recoveryKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleConfirmedChange = (checked: boolean) => {
    setConfirmed(checked)
    onConfirmedChange(checked)
  }

  return (
    <div className="w-full flex flex-col">
      <div className="text-center space-y-4">
        <h2 className="text-2xl font-bold">Save your recovery key</h2>
        <p className="text-muted-foreground">
          This is the only way to recover your data if you lose all your devices. We will never show this again.
        </p>
      </div>

      <div className="pt-5 space-y-4">
        <div className="rounded-xl bg-muted p-4">
          <p className="font-mono text-sm text-center break-all leading-relaxed">{formatRecoveryKey(recoveryKey)}</p>
        </div>

        <Button variant="outline" className="w-full" onClick={handleCopy}>
          {copied ? (
            <>
              <Check className="size-4 mr-2" />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-4 mr-2" />
              Copy to clipboard
            </>
          )}
        </Button>

        <label className="flex items-start gap-3 cursor-pointer">
          <Checkbox checked={confirmed} onCheckedChange={(v) => handleConfirmedChange(v === true)} className="mt-0.5" />
          <span className="text-sm">I have saved my recovery key</span>
        </label>

        <Button className="w-full" onClick={onDone} disabled={!confirmed}>
          Done
        </Button>
      </div>
    </div>
  )
}
