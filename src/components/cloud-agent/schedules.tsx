/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import { Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useFormatters } from '@/i18n/use-formatters'
import type { CloudScheduleConfig } from '@shared/cloud-agent/contracts'
import type { CloudAgentClient, CloudAgentView, CloudScheduleView } from '@/cloud-agent/client'
import { CloudError, CloudField } from './common'
import { usePreparedSave } from './use-prepared-save'

const ScheduleEditor = ({
  client,
  agent,
  schedule,
  onSaved,
  onCancel,
}: {
  client: CloudAgentClient
  agent: CloudAgentView
  schedule?: CloudScheduleView
  onSaved: () => void
  onCancel: () => void
}) => {
  const { t } = useLingui()
  const initial: CloudScheduleConfig = schedule?.config ?? {
    name: '',
    prompt: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cadence: { type: 'daily', hour: 9, minute: 0 },
  }
  const [draft, patch] = useReducer(
    (current: CloudScheduleConfig, value: Partial<CloudScheduleConfig>) => ({ ...current, ...value }),
    initial,
  )
  const [originalRecord] = useState(schedule?.record)
  const save = usePreparedSave({
    prepare: () => client.prepareSchedule(agent.record, draft, originalRecord),
    submit: client.submitSchedule,
    onSuccess: onSaved,
  })
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <fieldset disabled={save.isPending || save.hasPrepared} className="flex flex-col gap-4">
        <CloudField label={<Trans>Name</Trans>}>
          <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} required />
        </CloudField>
        <CloudField label={<Trans>Task</Trans>}>
          <Textarea value={draft.prompt} onChange={(e) => patch({ prompt: e.target.value })} rows={5} required />
        </CloudField>
        <CloudField label={<Trans>Time zone</Trans>}>
          <Input
            value={draft.timezone}
            onChange={(e) => patch({ timezone: e.target.value })}
            required
            placeholder={t`America/New_York`}
          />
        </CloudField>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={draft.cadence.type === 'daily' ? 'secondary' : 'ghost'}
            onClick={() => patch({ cadence: { type: 'daily', hour: 9, minute: 0 } })}
          >
            <Trans>Daily</Trans>
          </Button>
          <Button
            type="button"
            size="sm"
            variant={draft.cadence.type === 'interval' ? 'secondary' : 'ghost'}
            onClick={() => patch({ cadence: { type: 'interval', minutes: 60 } })}
          >
            <Trans>Repeat at an interval</Trans>
          </Button>
        </div>
        {draft.cadence.type === 'daily' ? (
          <CloudField label={<Trans>Time</Trans>}>
            <Input
              type="time"
              value={`${String(draft.cadence.hour).padStart(2, '0')}:${String(draft.cadence.minute).padStart(2, '0')}`}
              onChange={(event) => {
                const [hour, minute] = event.target.value.split(':').map(Number)
                patch({ cadence: { type: 'daily', hour, minute } })
              }}
              required
            />
          </CloudField>
        ) : (
          <CloudField label={<Trans>Interval in minutes</Trans>}>
            <Input
              type="number"
              min={1}
              value={draft.cadence.minutes}
              onChange={(event) => patch({ cadence: { type: 'interval', minutes: Number(event.target.value) } })}
              required
            />
          </CloudField>
        )}
      </fieldset>
      <CloudError error={save.error} />
      {save.hasPrepared && !save.isPending && (
        <p className="text-sm text-muted-foreground">
          <Trans>Retry to confirm the same saved change, or cancel to review the current state.</Trans>
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={save.isPending || !draft.name.trim() || !draft.prompt.trim()}>
          {save.hasPrepared ? <Trans>Retry save</Trans> : <Trans>Save schedule</Trans>}
        </Button>
      </div>
    </form>
  )
}

export const CloudSchedules = ({ client, agent }: { client: CloudAgentClient; agent: CloudAgentView }) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const queryClient = useQueryClient()
  const queryKey = ['cloud-agents', agent.record.ownerId, 'schedules', agent.record.id]
  const query = useQuery({
    queryKey,
    queryFn: () => client.getSchedules(agent.record),
    refetchInterval: 10000,
    retry: false,
    networkMode: 'always',
  })
  const [editing, setEditing] = useReducer((_current: string | null, id: string | null) => id, null)
  const refresh = () => queryClient.invalidateQueries({ queryKey })
  const toggle = useMutation({
    mutationFn: ({ schedule, enabled }: { schedule: CloudScheduleView; enabled: boolean }) =>
      client.saveSchedule(agent.record, schedule.config, schedule.record, enabled),
    onSuccess: refresh,
    retry: false,
    networkMode: 'always',
  })
  const selected = query.data?.find(({ record }) => record.id === editing)
  if (editing) {
    return (
      <ScheduleEditor
        key={editing}
        client={client}
        agent={agent}
        schedule={selected}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          void refresh()
        }}
      />
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">
          <Trans>Scheduled tasks</Trans>
        </h3>
        <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
          <Plus />
          <Trans>Add schedule</Trans>
        </Button>
      </div>
      <CloudError error={query.error ?? toggle.error} />
      {query.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          <Trans>Schedule a task for this agent to run while you are away.</Trans>
        </p>
      )}
      {query.data?.map((schedule) => (
        <div key={schedule.record.id} className="flex items-center justify-between gap-3 rounded-xl border p-4">
          <button
            type="button"
            className="min-w-0 flex-1 cursor-pointer text-left"
            onClick={() => setEditing(schedule.record.id)}
          >
            <span className="block truncate font-medium">{schedule.config.name}</span>
            {schedule.record.errorCode ? (
              <span role="status" className="block text-sm text-destructive">
                <Trans>The last attempt could not start.</Trans>
                {schedule.record.retryAt && (
                  <span className="block text-muted-foreground">
                    <Trans>Retry {formatters.relativeTime(schedule.record.retryAt)}</Trans>
                  </span>
                )}
              </span>
            ) : (
              <span className="block text-sm text-muted-foreground">
                {schedule.record.nextRunAt ? formatters.relativeTime(schedule.record.nextRunAt) : t`Paused`}
              </span>
            )}
          </button>
          <Switch
            aria-label={t`Enable ${schedule.config.name}`}
            checked={schedule.record.enabled}
            disabled={toggle.isPending}
            onCheckedChange={(enabled) => toggle.mutate({ schedule, enabled })}
          />
        </div>
      ))}
    </div>
  )
}
