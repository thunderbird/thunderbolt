/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { AdminPreview } from '../use-admin-preview-state'

export const AgentPolicy = ({ preview }: { preview: AdminPreview }) => {
  const { t } = useLingui()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t`Agent settings`}>
          <Settings2 />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="allow-personal-agents">
              <Trans>Allow personal agents</Trans>
            </Label>
            <p className="text-sm text-muted-foreground">
              <Trans>Let members connect their own ACP agents.</Trans>
            </p>
          </div>
          <Switch
            id="allow-personal-agents"
            checked={preview.state.policy.personalAgentsAllowed}
            onCheckedChange={(personalAgentsAllowed) =>
              preview.dispatch({ type: 'policy', patch: { personalAgentsAllowed } })
            }
          />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="allow-thunderbolt">
              <Trans>Built-in Thunderbolt agent</Trans>
            </Label>
            <p className="text-sm text-muted-foreground">
              <Trans>Give members the built-in assistant.</Trans>
            </p>
          </div>
          <Switch
            id="allow-thunderbolt"
            checked={preview.state.policy.thunderboltAllowed}
            onCheckedChange={(thunderboltAllowed) =>
              preview.dispatch({ type: 'policy', patch: { thunderboltAllowed } })
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
