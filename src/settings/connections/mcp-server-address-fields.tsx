/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import type { KeyboardEvent, ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAutofocusOnMount } from '@/hooks/use-autofocus-on-mount'
import type { McpUrlValidation } from '@/lib/mcp-url-validation'

/** Shared address/configuration fields; authentication and connection probes belong to the host form. */
export const McpServerAddressFields = ({
  name,
  url,
  transport,
  onNameChange,
  onUrlChange,
  onTransportChange,
  urlValidation,
  onUrlBlur,
  onUrlKeyDown,
  autofocus = false,
  showTransport = true,
  urlHint,
}: {
  name: string
  url: string
  transport: 'http' | 'sse' | 'iroh'
  onNameChange: (value: string) => void
  onUrlChange: (value: string) => void
  onTransportChange: (value: 'http' | 'sse') => void
  urlValidation: McpUrlValidation | null
  onUrlBlur?: () => void
  onUrlKeyDown?: (event: KeyboardEvent) => void
  autofocus?: boolean
  showTransport?: boolean
  urlHint?: ReactNode
}) => {
  const { t, i18n } = useLingui()
  const nameInputRef = useAutofocusOnMount<HTMLInputElement>(autofocus)
  return (
    <>
      <div className="grid grid-cols-1 gap-2">
        <Label htmlFor="name">
          <Trans>Name</Trans>
        </Label>
        <Input
          id="name"
          ref={nameInputRef}
          placeholder={t`Server name (used to prefix tools)`}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 gap-2">
        <Label htmlFor="url">
          <Trans>Server URL</Trans>
        </Label>
        <Input
          id="url"
          placeholder="http://localhost:8000/mcp/"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          onBlur={onUrlBlur}
          onKeyDown={onUrlKeyDown}
          aria-invalid={urlValidation?.ok === false}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        {urlValidation?.ok === false && (
          <p className="text-[length:var(--font-size-xs)] text-destructive">{i18n._(urlValidation.reason)}</p>
        )}
        {urlHint && <p className="text-[length:var(--font-size-xs)] text-muted-foreground">{urlHint}</p>}
      </div>

      {showTransport && (
        <div className="grid grid-cols-1 gap-2">
          <Label htmlFor="transport">
            <Trans>Transport</Trans>
          </Label>
          <Select
            value={transport}
            onValueChange={(value) => (value === 'http' || value === 'sse') && onTransportChange(value)}
          >
            <SelectTrigger id="transport" className="w-full rounded-lg">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">HTTP</SelectItem>
              <SelectItem value="sse">SSE</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </>
  )
}
