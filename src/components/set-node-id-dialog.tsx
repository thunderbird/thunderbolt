/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { decodePairingTicket } from '@/lib/pairing-ticket'
import { decodeQrFromFile } from '@/lib/qr-scan'
import { Loader2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'

type SetNodeIdDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  deviceName: string
  onConfirm: (nodeId: string) => Promise<void>
  isPending: boolean
}

type Status = { kind: 'idle' } | { kind: 'scanning' } | { kind: 'error'; message: string }

/**
 * Lets a trusted device bind a P2P pairing identity onto a device row by pasting a
 * pairing code or scanning one from an uploaded QR image. Default export for lazy loading.
 */
export default function SetNodeIdDialog({
  open,
  onOpenChange,
  deviceName,
  onConfirm,
  isPending,
}: SetNodeIdDialogProps) {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File) => {
    setStatus({ kind: 'scanning' })
    try {
      const decoded = await decodeQrFromFile(file)
      setText(decoded)
      setStatus({ kind: 'idle' })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Could not read QR code' })
    }
  }

  const handleSave = async () => {
    try {
      const { nodeId } = decodePairingTicket(text)
      try {
        await onConfirm(nodeId)
      } catch (err) {
        setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Could not bind the pairing code' })
      }
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Invalid pairing code' })
    }
  }

  const scanning = status.kind === 'scanning'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pair {deviceName}</DialogTitle>
          <DialogDescription>
            Paste a pairing code or upload its QR image to bind this device to its peer-to-peer identity.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="thunderbolt-pair:…"
            rows={3}
            spellCheck={false}
            className="font-mono text-[length:var(--font-size-xs)]"
          />

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) {
                void handleFile(file)
              }
              e.target.value = ''
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={scanning}
            onClick={() => fileInputRef.current?.click()}
          >
            {scanning ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Upload className="size-4 mr-1" />}
            Scan from image
          </Button>

          {status.kind === 'error' && (
            <p className="text-[length:var(--font-size-xs)] text-destructive">{status.message}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={isPending || scanning || text.trim().length === 0}>
            {isPending ? <Loader2 className="size-4 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
