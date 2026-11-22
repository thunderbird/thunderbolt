/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { SlidersHorizontal, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useFormatters } from '@/i18n/use-formatters'
import type { AuditEventQuery, AuditOutcome } from '@shared/admin-api'
import { auditActionLabels, getAuditActionLabel, getAuditTargetLabel } from '../../api/audit-action-labels'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { useConnections } from '../../api/use-connections'
import { DateField } from '../../components/date-field'
import { AuditActorPicker } from './audit-actor-picker'
import { toDayInput, toRangeEnd, toRangeStart } from './audit-date-range'
import { auditActionGroups, auditTargetTypes } from './audit-filter-options'

// Radix Select can't hold an empty value, so "no filter" has its own.
const any = 'any'

const outcomeLabels: Record<AuditOutcome, MessageDescriptor> = {
  success: msg`Success`,
  failure: msg`Failure`,
  denied: msg`Denied`,
}

type AuditLogFiltersProps = {
  filters: AuditEventQuery
  onChange: (filters: AuditEventQuery) => void
}

const Field = ({ id, label, children }: { id: string; label: string; children: ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <Label htmlFor={id} className="text-[length:var(--font-size-sm)] text-muted-foreground">
      {label}
    </Label>
    {children}
  </div>
)

/** A set filter, with a button that removes it. */
const FilterChip = ({
  children,
  removeLabel,
  onRemove,
}: {
  children: ReactNode
  removeLabel: string
  onRemove: () => void
}) => (
  <span className="inline-flex min-w-0 items-center gap-1 rounded-lg bg-muted py-0.5 pr-0.5 pl-2 text-[length:var(--font-size-sm)]">
    <span className="truncate">{children}</span>
    <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={removeLabel} onClick={onRemove}>
      <X />
    </Button>
  </span>
)

/** The actor filter's chip text: the member's name once it's known, else the id a link carried. */
const ActorName = ({ actorId }: { actorId: string }) => {
  const api = useAdminApi()
  const member = useQuery({
    queryKey: adminQueryKeys.members.detail(actorId),
    queryFn: () => api.members.get(actorId),
    retry: false,
  })
  return <>{member.data ? member.data.name || member.data.email : actorId}</>
}

/** A target type by its label, or as its raw type when this build doesn't know it. */
const useTargetTypeName = () => {
  const { i18n } = useLingui()
  return (type: string) => {
    const label = getAuditTargetLabel(type)
    return label ? i18n._(label) : type
  }
}

/**
 * The audit log's filters, all in one popover behind an icon button in the page header. A filter
 * the popover can't set (a target, which only arrives by a link) still counts, and shows as a chip.
 */
export const AuditLogFiltersButton = ({ filters, onChange }: AuditLogFiltersProps) => {
  const { t, i18n } = useLingui()
  const connections = useConnections()
  const targetTypeName = useTargetTypeName()
  const activeCount = Object.values(filters).filter(Boolean).length

  const set = (update: Partial<AuditEventQuery>) => onChange({ ...filters, ...update })
  const fromSelect = (value: string) => (value === any ? undefined : value)
  const { outcome, actorId, targetType, connectionId } = filters

  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* Sized and styled like the other screens' header "+" button. */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="-mr-2 border bg-card hover:bg-accent max-md:mr-0"
          aria-label={activeCount > 0 ? t`Filters (${activeCount})` : t`Filters`}
        >
          <SlidersHorizontal />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3">
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

        <div className="grid grid-cols-2 gap-2">
          <Field id="audit-filter-from" label={t`From`}>
            <DateField
              id="audit-filter-from"
              value={toDayInput(filters.from)}
              placeholder={<Trans>Any date</Trans>}
              onChange={(day) => set({ from: day ? toRangeStart(day) : undefined })}
            />
          </Field>
          <Field id="audit-filter-to" label={t`To`}>
            <DateField
              id="audit-filter-to"
              value={toDayInput(filters.to)}
              placeholder={<Trans>Any date</Trans>}
              onChange={(day) => set({ to: day ? toRangeEnd(day) : undefined })}
            />
          </Field>
        </div>

        <Field id="audit-filter-outcome" label={t`Outcome`}>
          <Select
            value={outcome ?? any}
            onValueChange={(value) => set({ outcome: fromSelect(value) as AuditOutcome | undefined })}
          >
            <SelectTrigger id="audit-filter-outcome" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={any}>{t`Any outcome`}</SelectItem>
              {(['success', 'failure', 'denied'] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  {i18n._(outcomeLabels[value])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field id="audit-filter-actor" label={t`Actor`}>
          <AuditActorPicker id="audit-filter-actor" actorId={actorId} onChange={(id) => set({ actorId: id })} />
        </Field>

        <Field id="audit-filter-target" label={t`Target type`}>
          <Select value={targetType ?? any} onValueChange={(value) => set({ targetType: fromSelect(value) })}>
            <SelectTrigger id="audit-filter-target" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={any}>{t`Any target`}</SelectItem>
              {auditTargetTypes.map((type) => (
                <SelectItem key={type} value={type}>
                  {targetTypeName(type)}
                </SelectItem>
              ))}
              {targetType && !getAuditTargetLabel(targetType) && (
                <SelectItem value={targetType}>{targetType}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </Field>

        <Field id="audit-filter-connection" label={t`Connection`}>
          <Select value={connectionId ?? any} onValueChange={(value) => set({ connectionId: fromSelect(value) })}>
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
              {connectionId && !connections.data?.some((item) => item.id === connectionId) && (
                <SelectItem value={connectionId}>{connectionId}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </Field>

        <div className="flex justify-end border-t pt-3">
          <Button type="button" variant="ghost" size="sm" disabled={activeCount === 0} onClick={() => onChange({})}>
            <Trans>Clear filters</Trans>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Each set filter as a chip that removes it, and a way to clear them all. Renders nothing with no filter set. */
export const AuditLogFilterChips = ({ filters, onChange }: AuditLogFiltersProps) => {
  const { t, i18n } = useLingui()
  const formatters = useFormatters()
  const connections = useConnections()
  const targetTypeName = useTargetTypeName()
  if (!Object.values(filters).some(Boolean)) {
    return null
  }

  const set = (update: Partial<AuditEventQuery>) => onChange({ ...filters, ...update })
  const { action, from, to, outcome, actorId, targetType, targetId, connectionId } = filters
  const actionLabel = action ? getAuditActionLabel(action) : null
  const actionName = action ? (actionLabel ? i18n._(actionLabel) : action) : ''
  const fromDate = from ? formatters.date(from) : ''
  const toDate = to ? formatters.date(to) : ''
  const outcomeName = outcome ? i18n._(outcomeLabels[outcome]) : ''
  const targetTypeLabel = targetType ? targetTypeName(targetType) : ''
  const connectionLabel = connectionId
    ? (connections.data?.find((item) => item.id === connectionId)?.name ?? connectionId)
    : ''

  return (
    <div className="flex flex-wrap items-center gap-2">
      {action && (
        <FilterChip removeLabel={t`Remove the action filter`} onRemove={() => set({ action: undefined })}>
          <Trans>Action: {actionName}</Trans>
        </FilterChip>
      )}
      {from && (
        <FilterChip removeLabel={t`Remove the start date`} onRemove={() => set({ from: undefined })}>
          <Trans>From: {fromDate}</Trans>
        </FilterChip>
      )}
      {to && (
        <FilterChip removeLabel={t`Remove the end date`} onRemove={() => set({ to: undefined })}>
          <Trans>To: {toDate}</Trans>
        </FilterChip>
      )}
      {outcome && (
        <FilterChip removeLabel={t`Remove the outcome filter`} onRemove={() => set({ outcome: undefined })}>
          <Trans>Outcome: {outcomeName}</Trans>
        </FilterChip>
      )}
      {actorId && (
        <FilterChip removeLabel={t`Remove the actor filter`} onRemove={() => set({ actorId: undefined })}>
          <Trans>
            Actor: <ActorName actorId={actorId} />
          </Trans>
        </FilterChip>
      )}
      {targetType && (
        <FilterChip removeLabel={t`Remove the target type filter`} onRemove={() => set({ targetType: undefined })}>
          <Trans>Target type: {targetTypeLabel}</Trans>
        </FilterChip>
      )}
      {targetId && (
        <FilterChip removeLabel={t`Remove the target filter`} onRemove={() => set({ targetId: undefined })}>
          <Trans>
            Target: <code>{targetId}</code>
          </Trans>
        </FilterChip>
      )}
      {connectionId && (
        <FilterChip removeLabel={t`Remove the connection filter`} onRemove={() => set({ connectionId: undefined })}>
          <Trans>Connection: {connectionLabel}</Trans>
        </FilterChip>
      )}
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange({})}>
        <Trans>Clear filters</Trans>
      </Button>
    </div>
  )
}
