/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { findAllowOption } from '@/chats/chat-store'
import { Button } from '@/components/ui/button'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { ShieldAlert } from 'lucide-react'
import { useState } from 'react'

type PermissionDialogProps = {
  onAlwaysAllowAgent: () => void
  onAlwaysAllowTool: () => void
  onRespond: (response: RequestPermissionResponse) => void
  request: RequestPermissionRequest
}

const permissionRequired = msg`Permission Required`

const toolKindLabel = (kind?: string | null): MessageDescriptor => {
  switch (kind) {
    case 'edit':
      return msg`Edit file`
    case 'delete':
      return msg`Delete`
    case 'execute':
      return msg`Run command`
    case 'move':
      return msg`Move file`
    default:
      return msg`Action`
  }
}

/** Label for the kind-scoped always-allow button. Names the breadth granted so
 *  the user sees they're allowing every action of this kind, not just the one
 *  command shown.
 *
 *  One whole message per kind rather than the kind label interpolated into a
 *  sentence template: a translated fragment dropped into a translated frame
 *  gets the grammar wrong in most languages. */
const alwaysAllowKindLabel = (kind?: string | null): MessageDescriptor => {
  switch (kind) {
    case 'edit':
      return msg`Always allow all Edit file actions`
    case 'delete':
      return msg`Always allow all Delete actions`
    case 'execute':
      return msg`Always allow all Run command actions`
    case 'move':
      return msg`Always allow all Move file actions`
    default:
      return msg`Always allow all actions of this kind`
  }
}

const optionVariant = (kind: PermissionOption['kind']): 'default' | 'destructive' | 'outline' | 'secondary' => {
  switch (kind) {
    case 'allow_once':
      return 'default'
    case 'allow_always':
      return 'secondary'
    case 'reject_once':
      return 'outline'
    case 'reject_always':
      return 'destructive'
  }
}

/** Formats ACP raw tool input as complete plain text for informed approval. */
const formatToolInput = (input: unknown): string | undefined =>
  typeof input === 'string' ? input : JSON.stringify(input, null, 2)

/**
 * Inline permission prompt rendered above the prompt input when an ACP agent
 * issues a `requestPermission` for a tool call. The dialog disables itself
 * after the first selection so a fast double-click can't fire two responses.
 */
export const PermissionDialog = ({
  request,
  onRespond,
  onAlwaysAllowTool,
  onAlwaysAllowAgent,
}: PermissionDialogProps) => {
  const { i18n, t } = useLingui()
  const [responded, setResponded] = useState(false)

  const allowOption = findAllowOption(request.options)
  const toolCall = request.toolCall
  const title = toolCall?.title ?? i18n._(permissionRequired)
  const kind = toolCall?.kind
  const toolInput = toolCall?.rawInput === undefined ? undefined : formatToolInput(toolCall.rawInput)

  const respondOnce = (respond: () => void) => {
    if (responded) {
      return
    }
    setResponded(true)
    respond()
  }

  const handleSelect = (option: PermissionOption) =>
    respondOnce(() =>
      onRespond({
        outcome: { outcome: 'selected', optionId: option.optionId },
      }),
    )

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 my-2" role="dialog">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 text-amber-500" />
        <span className="font-medium text-[length:var(--font-size-body)]">{i18n._(toolKindLabel(kind))}</span>
      </div>

      <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{title}</p>

      {toolInput !== undefined && (
        <div className="flex flex-col gap-1">
          <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
            <Trans>Command / arguments</Trans>
          </p>
          <pre
            aria-label={t`Tool input`}
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-[length:var(--font-size-xs)]"
          >
            {toolInput}
          </pre>
        </div>
      )}

      {toolCall?.locations && toolCall.locations.length > 0 && (
        <div className="text-[length:var(--font-size-xs)] text-muted-foreground font-mono">
          {toolCall.locations.map((loc, i) => (
            <div key={i}>
              {loc.path}
              {loc.line != null && `:${loc.line}`}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            variant={optionVariant(option.kind)}
            size="sm"
            disabled={responded}
            onClick={() => handleSelect(option)}
          >
            {option.name}
          </Button>
        ))}
      </div>

      {allowOption && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button variant="ghost" size="sm" disabled={responded} onClick={() => respondOnce(onAlwaysAllowTool)}>
            {i18n._(alwaysAllowKindLabel(kind))}
          </Button>
          <Button variant="ghost" size="sm" disabled={responded} onClick={() => respondOnce(onAlwaysAllowAgent)}>
            <Trans>Always allow everything from this agent</Trans>
          </Button>
        </div>
      )}
    </div>
  )
}
