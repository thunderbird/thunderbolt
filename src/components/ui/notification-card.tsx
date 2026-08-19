/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AnimatePresence, m } from 'framer-motion'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type NotificationCardProps = {
  open: boolean
  icon: ReactNode
  message: string
  details?: ReactNode
  actions?: ReactNode
  onDismiss: () => void
  dismissLabel?: string
  positionClassName?: string
}

/** Shared animated notification surface for transient and actionable messages. */
export const NotificationCard = ({
  open,
  icon,
  message,
  details,
  actions,
  onDismiss,
  dismissLabel = 'Dismiss notification',
  positionClassName,
}: NotificationCardProps) => (
  <AnimatePresence>
    {open && (
      <m.div
        key="notification-card"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        className={cn('fixed bottom-4 z-50', positionClassName ?? 'inset-x-4 md:right-4 md:left-auto md:max-w-sm')}
      >
        <div className="rounded-xl border border-border bg-card p-4 shadow-lg">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0">{icon}</div>
            <div className="min-w-0 flex-1">
              <p className="text-[length:var(--font-size-sm)] font-medium text-foreground">{message}</p>
              {details}
              {actions && <div className="mt-3 flex gap-2">{actions}</div>}
            </div>
            <Button variant="ghost" size="icon-xs" onClick={onDismiss} aria-label={dismissLabel}>
              <X className="size-4" />
            </Button>
          </div>
        </div>
      </m.div>
    )}
  </AnimatePresence>
)
