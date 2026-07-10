/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

/** Copyable monospace command shared by setup and pairing panels. */
export const CopyCommandRow = ({ command, label }: { command: string; label: string }) => {
  const { copy, isCopied } = useCopyToClipboard()
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-[length:var(--font-size-xs)]">
        {command}
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="size-8 shrink-0 p-0"
        aria-label={label}
        onClick={() => void copy(command)}
      >
        {isCopied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
      </Button>
    </div>
  )
}
