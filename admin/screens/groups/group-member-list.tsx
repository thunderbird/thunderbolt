/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { X } from 'lucide-react'
import { Button, mutedIconButtonClass } from '@/components/ui/button'
import type { DraftMember } from './use-group-form-state'

type GroupMemberListProps = {
  members: DraftMember[]
  /** Each row gets a remove button when given. */
  onRemove?: (userId: string) => void
  /** Turns the remove buttons off, as while a save is in flight. */
  disabled?: boolean
}

/** A group's members, by name with their email under it. */
export const GroupMemberList = ({ members, onRemove, disabled }: GroupMemberListProps) => {
  const { t } = useLingui()
  if (members.length === 0) {
    return null
  }
  return (
    <ul className="flex flex-col gap-1">
      {members.map((member) => (
        <li key={member.userId} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5">
          <span className="min-w-0">
            <span className="block truncate text-[length:var(--font-size-body)]">{member.label}</span>
            {member.detail && (
              <span className="block truncate text-[length:var(--font-size-xs)] text-muted-foreground">
                {member.detail}
              </span>
            )}
          </span>
          {onRemove && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t`Remove ${member.label} from the group`}
              className={mutedIconButtonClass}
              disabled={disabled}
              onClick={() => onRemove(member.userId)}
            >
              <X />
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}
