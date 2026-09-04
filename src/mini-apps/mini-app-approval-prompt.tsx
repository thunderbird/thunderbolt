/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId } from 'react'
import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { ChevronRight, ShieldAlert } from 'lucide-react'
import type { PendingMiniAppApproval } from '@/chats/chat-store'

/**
 * Render one argument value for a human.
 *
 * Primitives read as themselves; anything nested falls back to compact JSON,
 * because inventing a prettier rendering for arbitrary structure is how you end
 * up with a prompt that hides the interesting half of what it's approving.
 */
const formatValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value)
  }
  return JSON.stringify(value)
}

/** Arguments as label/value pairs, or null when the tool takes none. */
const toArgEntries = (args: unknown): { key: string; value: string }[] | null => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return args === undefined || args === null ? null : [{ key: 'value', value: formatValue(args) }]
  }
  const entries = Object.entries(args)
  return entries.length === 0 ? null : entries.map(([key, value]) => ({ key, value: formatValue(value) }))
}

type MiniAppApprovalPromptProps = {
  pending: PendingMiniAppApproval
  appName: string
  onDecide: (approved: boolean) => void
}

/**
 * Approval prompt for a Mini App tool that will change something.
 *
 * Written for the person deciding, not the person debugging. Three things it
 * deliberately does *not* do:
 *
 * - Lead with the tool's `name`. That's an identifier; `annotations.title` is
 *   the sentence the app author wrote for exactly this moment.
 * - Show `tool.description` up front. That prose is aimed at the model — it
 *   tends to be long and full of instructions about when to call the tool,
 *   which is not what someone deciding whether to allow it needs to read.
 * - Print raw JSON. The arguments *are* the decision ("status → shipped"), so
 *   they're rendered as pairs; the JSON stays available underneath for when the
 *   pairs aren't enough.
 *
 * Native `<details>` rather than a Collapsible primitive: it's a disclosure with
 * no shared state, and the element already handles keyboard and screen readers.
 *
 * Deliberately *not* the ACP `PermissionDialog` component: that one is shaped
 * around an ACP `requestPermission` (agent id, ACP option ids,
 * allow-always-for-agent), and synthesising those for a non-ACP flow would be
 * coupling wearing reuse's clothes. It matches that dialog's placement and
 * visual language instead — same card above the prompt input, same amber shield
 * — so approving a Mini App tool and approving an agent tool are one idea the
 * user learns once.
 *
 * It used to sit as a bar over the app, on the reasoning that the app is what's
 * about to change. That was wrong in practice: a decision belongs where the
 * user is reading the model's reply, and putting it anywhere else meant a second
 * pointer in the chat saying "your approval is over there".
 *
 * No `aria-modal` and no focus grab, both of which the old placement needed.
 * Rendered after the iframe, a keyboard user had to tab through the whole
 * customer app to reach a decision blocking them; inline above the composer it
 * is already in reading order, and stealing focus from someone mid-sentence
 * would be its own bug.
 */
export const MiniAppApprovalPrompt = ({ pending, appName, onDecide }: MiniAppApprovalPromptProps) => {
  const { tool, args } = pending
  const action = tool.annotations?.title ?? tool.name
  const entries = toArgEntries(args)
  const headingId = useId()

  return (
    <div className="rounded-xl border border-border bg-card p-4 my-2" role="dialog" aria-labelledby={headingId}>
      <div className="flex items-start gap-3">
        <ShieldAlert className="size-[var(--icon-size-sm)] text-amber-500 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0 space-y-1.5">
          <p id={headingId} className="text-[length:var(--font-size-body)] font-medium">
            {action}
          </p>

          {entries && (
            <ul className="flex flex-wrap gap-x-3 gap-y-1">
              {entries.map((entry) => (
                <li key={entry.key} className="text-[length:var(--font-size-sm)] min-w-0">
                  <span className="text-muted-foreground">{entry.key}</span>{' '}
                  <span className="font-medium break-all">{entry.value}</span>
                </li>
              ))}
            </ul>
          )}

          <details className="group">
            <summary className="inline-flex cursor-pointer items-center gap-1 text-[length:var(--font-size-xs)] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-[var(--icon-size-sm)] transition-transform group-open:rotate-90" />
              <Trans>Requested by {appName}</Trans>
            </summary>
            <div className="mt-1.5 space-y-1.5 text-[length:var(--font-size-xs)] text-muted-foreground">
              <p>
                {/* Skipped when the heading already *is* the name — repeating an
                    identifier twice in one prompt reads as a rendering bug. */}
                {action !== tool.name && <span className="font-mono">{tool.name}</span>}
                {action !== tool.name && tool.description && ' — '}
                {tool.description}
              </p>
              {args !== undefined && args !== null && (
                <pre className="max-h-24 overflow-auto rounded-md bg-muted p-2">{JSON.stringify(args, null, 2)}</pre>
              )}
            </div>
          </details>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={() => onDecide(false)}>
            <Trans>Deny</Trans>
          </Button>
          <Button size="sm" onClick={() => onDecide(true)}>
            <Trans>Approve</Trans>
          </Button>
        </div>
      </div>
    </div>
  )
}
