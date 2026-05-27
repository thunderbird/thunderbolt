/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ResponsiveModalContentComposable,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { Dialog } from '@/components/ui/dialog'
import { getPlatform, isTauri } from '@/lib/platform'

/** Maps a user-entered URL to the ACP transport flavor we support, or `null`
 *  when the scheme is unsupported (or the URL is malformed). WebSocket is the
 *  only supported remote transport — HTTP/HTTPS endpoints are rejected. */
export const inferTransport = (url: string): 'websocket' | null => {
  try {
    const u = new URL(url)
    if (u.protocol === 'ws:' || u.protocol === 'wss:') {
      return 'websocket'
    }
    return null
  } catch {
    return null
  }
}

/** True when running on iOS via Tauri — Apple's App Transport Security rejects
 *  cleartext (`ws://`) by default, so we surface a clear error upfront instead
 *  of letting the connection silently fail. */
const defaultIsTauriIOS = (): boolean => isTauri() && getPlatform() === 'ios'

/** Pure validation of `url` against the platform's transport rules. Returns
 *  the inferred transport on success, or a user-facing error string. Extracted
 *  so the test suite can exercise it without rendering the dialog. */
export const validateAgentUrl = (
  url: string,
  isIos: () => boolean = defaultIsTauriIOS,
): { transport: 'websocket' } | { error: string } => {
  const transport = inferTransport(url)
  if (!transport) {
    return { error: 'Only WebSocket endpoints are supported (wss:// or ws://)' }
  }
  if (isIos() && new URL(url).protocol === 'ws:') {
    return { error: 'iOS requires a secure URL (wss://)' }
  }
  return { transport }
}

export type AddCustomAgentPayload = {
  name: string
  url: string
  description: string | null
  transport: 'websocket'
}

type AddCustomAgentDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (payload: AddCustomAgentPayload) => Promise<void> | void
  /** Test/DI override for the iOS guard. Production callers omit this. */
  isIos?: () => boolean
}

export const AddCustomAgentDialog = ({ open, onOpenChange, onSubmit, isIos }: AddCustomAgentDialogProps) => {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const trimmedName = name.trim()
  const trimmedUrl = url.trim()
  const trimmedDescription = description.trim()
  const canSubmit = trimmedName.length > 0 && trimmedUrl.length > 0 && !submitting

  const resetForm = () => {
    setName('')
    setUrl('')
    setDescription('')
    setError(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      resetForm()
    }
    onOpenChange(next)
  }

  const handleSubmit = async () => {
    if (!canSubmit) {
      return
    }
    const result = validateAgentUrl(trimmedUrl, isIos)
    if ('error' in result) {
      setError(result.error)
      return
    }
    setSubmitting(true)
    setError(null)
    await onSubmit({
      name: trimmedName,
      url: trimmedUrl,
      description: trimmedDescription.length > 0 ? trimmedDescription : null,
      transport: result.transport,
    })
    setSubmitting(false)
    resetForm()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveModalContentComposable className="sm:max-w-[500px]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Add Custom Agent</ResponsiveModalTitle>
          <ResponsiveModalDescription>
            Connect a remote agent that speaks the Agent Client Protocol.
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>
        <div className="grid gap-4 pt-4 pb-2">
          <div className="grid gap-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              placeholder="My Agent"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-url">URL</Label>
            <Input
              id="agent-url"
              placeholder="wss://example.com/ws"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                if (error) {
                  setError(null)
                }
              }}
              autoComplete="off"
            />
            <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
              WebSocket endpoint for the remote ACP agent
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-description">Description</Label>
            <Input
              id="agent-description"
              placeholder="Optional"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              autoComplete="off"
            />
          </div>
          {error && (
            <p role="alert" className="text-[length:var(--font-size-sm)] text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            Add Agent
          </Button>
        </div>
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
