import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Check, Copy, Download } from 'lucide-react'
import { useEffect, useState } from 'react'

type CreateShowKeyStepProps = {
  recoveryKey: string
  recoveryKeySaved: boolean
  onConfirmSaved: (saved: boolean) => void
  onContinue: () => void
}

export const CreateShowKeyStep = ({
  recoveryKey,
  recoveryKeySaved,
  onConfirmSaved,
  onContinue,
}: CreateShowKeyStepProps) => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const handleCopy = async () => {
    await navigator.clipboard.writeText(recoveryKey)
    setCopied(true)
  }

  const handleDownload = () => {
    const blob = new Blob(
      [
        `Thunderbolt Recovery Key\n\n${recoveryKey}\n\nKeep this key safe. You will need it to restore access to your encrypted data.\n`,
      ],
      { type: 'text/plain' },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'thunderbolt-recovery-key.txt'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 100)
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        This is your recovery key. Save it somewhere safe — you'll need it to restore access to your encrypted data if
        you lose your device.
      </p>

      <div className="rounded-lg border bg-muted/50 p-4">
        <code className="text-xs font-mono break-all leading-relaxed select-all">{recoveryKey}</code>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1" onClick={handleCopy}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="outline" size="sm" className="flex-1" onClick={handleDownload}>
          <Download className="h-4 w-4" />
          Download
        </Button>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <Checkbox checked={recoveryKeySaved} onCheckedChange={(checked) => onConfirmSaved(checked === true)} />
        <span className="text-sm">I have saved my recovery key</span>
      </label>

      <Button disabled={!recoveryKeySaved} onClick={onContinue}>
        Continue
      </Button>
    </div>
  )
}
