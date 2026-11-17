/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

type CopyableFieldProps = {
  /** Names the read-only field. */
  label: string
  /** Names the copy button, as a whole sentence. */
  copyLabel: string
  value: string
}

/**
 * A value in a read-only field, whole and selectable, with a copy button. Unlike `CopyCommandRow` it never
 * truncates, for a value someone has to read or paste in full, such as a token.
 */
export const CopyableField = ({ label, copyLabel, value }: CopyableFieldProps) => {
  const { copy, isCopied } = useCopyToClipboard()
  return (
    <div className="flex items-center gap-2">
      <Input readOnly aria-label={label} value={value} className="min-w-0 flex-1 font-mono" />
      <Button type="button" variant="outline" size="icon" aria-label={copyLabel} onClick={() => void copy(value)}>
        {isCopied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
      </Button>
    </div>
  )
}
