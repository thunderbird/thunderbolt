/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Box, Cloud, Monitor, Server } from 'lucide-react'
import { useProjectExecution } from '@/agent-execution/use-project-execution'
import { useSshEnvironmentsStore } from '@/agent-execution/ssh-environments'
import { SshEnvironmentStatus } from '@/components/ssh-environments'

/** Display the immutable project environment without offering a destination switch. */
export const ProjectExecutionSummary = ({ projectId }: { projectId: string }) => {
  const { t } = useLingui()
  const { declaration, execution, binding, loading } = useProjectExecution(projectId)
  const environments = useSshEnvironmentsStore((state) => state.environments)
  const location = declaration?.location
  const environment = declaration?.location === 'ssh' ? environments[declaration.environmentId] : undefined
  const Icon = location === 'ssh' ? Server : location === 'computer' ? Monitor : location === 'cloud' ? Cloud : Box
  const label = loading
    ? t`Loading…`
    : location === 'ssh'
      ? (environment?.name ?? t`SSH environment unavailable`)
      : location === 'computer'
        ? t`This computer`
        : location === 'cloud'
          ? t`Cloud`
          : location === 'sandbox'
            ? t`Local sandbox`
            : t`Environment unavailable`
  const resolved = execution ?? binding
  const cwd = resolved?.location === 'computer' || resolved?.location === 'ssh' ? resolved.cwd : undefined

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[length:var(--font-size-sm)] font-medium">
        <Trans>Agent environment</Trans>
      </span>
      <div aria-label={t`Project environment`} className="flex items-center gap-2 text-sm">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{label}</span>
        {declaration?.location === 'ssh' && <SshEnvironmentStatus environmentId={declaration.environmentId} />}
      </div>
      {cwd && <p className="break-all text-xs text-muted-foreground">{cwd}</p>}
    </div>
  )
}
