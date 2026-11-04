/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'

export type AgentEnvironment = 'remote' | 'cloud'

/** Choose an execution environment before creating an agent and its sessions. */
export const AgentEnvironmentField = ({
  value,
  onChange,
}: {
  value: AgentEnvironment
  onChange?: (environment: AgentEnvironment) => void
}) => {
  const { t } = useLingui()
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="agent-environment">
        <Trans>Environment</Trans>
      </Label>
      <Select
        value={value}
        disabled={!onChange}
        onValueChange={(next) => {
          if (next === 'remote' || next === 'cloud') {
            onChange?.(next)
          }
        }}
      >
        <SelectTrigger id="agent-environment" className="w-full" aria-label={t`Environment`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="remote">
            <Trans>Connected environment</Trans>
          </SelectItem>
          <SelectItem value="cloud">
            <Trans>Cloud</Trans>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
