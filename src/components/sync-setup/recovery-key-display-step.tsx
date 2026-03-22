import { Button } from '@/components/ui/button'
import { Copy, Check } from 'lucide-react'
import { useState } from 'react'

type RecoveryKeyDisplayStepProps = {
  recoveryKey: string
  onDone: () => void
}

/** Formats a 64-char hex string into 8-char groups separated by spaces */
const formatRecoveryKey = (key: string): string => key.match(/.{1,8}/g)?.join(' ') ?? key

export const RecoveryKeyDisplayStep = ({ recoveryKey, onDone }: RecoveryKeyDisplayStepProps) => {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(recoveryKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Save your recovery key</h2>
        <p className="text-sm text-muted-foreground mt-2">
          Sync is now active. This is the only way to recover your data if you lose all your devices. We will never show
          this again.
        </p>
      </div>

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

      <Button className="w-full" onClick={onDone}>
        Done
      </Button>
    </div>
  )
}
