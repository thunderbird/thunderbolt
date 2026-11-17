/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { SlidersHorizontal, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { AuditEventQuery, AuditOutcome } from '@shared/admin-api'
import { auditActionLabels, getAuditTargetLabel } from '../../api/audit-action-labels'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { AuditActorPicker } from './audit-actor-picker'
import { toDayInput, toRangeEnd, toRangeStart } from './audit-date-range'
import { auditActionGroups, auditTargetTypes } from './audit-filter-options'

// Radix Select can't hold an empty value, so "no filter" has its own.
const any = 'any'

type AuditLogFiltersProps = {
  filters: AuditEventQuery
  onChange: (filters: AuditEventQuery) => void
  /** Page actions at the end of the toolbar, such as Refresh. */
  actions?: ReactNode
}

const Field = ({ id, label, children }: { id: string; label: string; children: ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <Label htmlFor={id} className="text-[length:var(--font-size-sm)] text-muted-foreground">
      {label}
    </Label>
    {children}
  </div>
)

/** The audit log's filters. Narrow screens fold them behind a "Filters" button. */
export const AuditLogFilters = ({ filters, onChange, actions }: AuditLogFiltersProps) => {
  const { t, i18n } = useLingui()
  const api = useAdminApi()
  const [open, setOpen] = useState(false)
  const connections = useQuery({ queryKey: adminQueryKeys.connections.list(), queryFn: api.connections.list })
  const activeCount = Object.values(filters).filter(Boolean).length

  const { targetId } = filters

  const set = (update: Partial<AuditEventQuery>) => onChange({ ...filters, ...update })
  const fromSelect = (value: string) => (value === any ? undefined : value)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="md:hidden"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <SlidersHorizontal />
          {activeCount > 0 ? <Trans>Filters ({activeCount})</Trans> : <Trans>Filters</Trans>}
        </Button>
        {targetId && (
          <span className="inline-flex min-w-0 items-center gap-1 rounded-lg bg-muted py-0.5 pr-0.5 pl-2 text-[length:var(--font-size-sm)]">
            <span className="truncate">
              <Trans>
                Target: <code>{targetId}</code>
              </Trans>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t`Remove the target filter`}
              onClick={() => set({ targetId: undefined })}
            >
              <X />
            </Button>
          </span>
        )}
        {activeCount > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange({})}>
            <Trans>Clear filters</Trans>
          </Button>
        )}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>

      <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4', !open && 'max-md:hidden')}>
        <Field id="audit-filter-action" label={t`Action`}>
          <Select value={filters.action ?? any} onValueChange={(value) => set({ action: fromSelect(value) })}>
            <SelectTrigger id="audit-filter-action" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={any}>{t`Any action`}</SelectItem>
              {auditActionGroups.map((group) => (
                <SelectGroup key={group.id}>
                  <SelectLabel>{i18n._(group.label)}</SelectLabel>
                  {group.actions.map((action) => (
                    <SelectItem key={action} value={action}>
                      {i18n._(auditActionLabels[action])}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field id="audit-filter-outcome" label={t`Outcome`}>
          <Select
            value={filters.outcome ?? any}
            onValueChange={(value) => set({ outcome: fromSelect(value) as AuditOutcome | undefined })}
          >
            <SelectTrigger id="audit-filter-outcome" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={any}>{t`Any outcome`}</SelectItem>
              <SelectItem value="success">{t`Success`}</SelectItem>
              <SelectItem value="failure">{t`Failure`}</SelectItem>
              <SelectItem value="denied">{t`Denied`}</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field id="audit-filter-actor" label={t`Actor`}>
          <AuditActorPicker
            id="audit-filter-actor"
            actorId={filters.actorId}
            onChange={(actorId) => set({ actorId })}
          />
        </Field>

        <Field id="audit-filter-target" label={t`Target type`}>
          <Select value={filters.targetType ?? any} onValueChange={(value) => set({ targetType: fromSelect(value) })}>
            <SelectTrigger id="audit-filter-target" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={any}>{t`Any target`}</SelectItem>
              {auditTargetTypes.map((type) => {
                const label = getAuditTargetLabel(type)
                return (
                  <SelectItem key={type} value={type}>
                    {label ? i18n._(label) : type}
                  </SelectItem>
                )
              })}
              {filters.targetType && !getAuditTargetLabel(filters.targetType) && (
                <SelectItem value={filters.targetType}>{filters.targetType}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </Field>

        <Field id="audit-filter-connection" label={t`Connection`}>
          <Select
            value={filters.connectionId ?? any}
            onValueChange={(value) => set({ connectionId: fromSelect(value) })}
          >
            <SelectTrigger id="audit-filter-connection" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={any}>{t`Any connection`}</SelectItem>
              {connections.data?.map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.name}
                </SelectItem>
              ))}
              {filters.connectionId && !connections.data?.some((item) => item.id === filters.connectionId) && (
                <SelectItem value={filters.connectionId}>{filters.connectionId}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </Field>

        <Field id="audit-filter-from" label={t`From`}>
          <Input
            id="audit-filter-from"
            type="date"
            value={toDayInput(filters.from)}
            onChange={(event) => set({ from: event.target.value ? toRangeStart(event.target.value) : undefined })}
          />
        </Field>

        <Field id="audit-filter-to" label={t`To`}>
          <Input
            id="audit-filter-to"
            type="date"
            value={toDayInput(filters.to)}
            onChange={(event) => set({ to: event.target.value ? toRangeEnd(event.target.value) : undefined })}
          />
        </Field>
      </div>
    </div>
  )
}
