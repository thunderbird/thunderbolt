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

export const CompanyModelPolicy = ({ preview }: { preview: AdminPreview }) => {
  const { t } = useLingui()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t`Model settings`}>
          <Settings2 />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="allow-personal-models">
              <Trans>Personal models</Trans>
            </Label>
            <p className="text-sm text-muted-foreground">
              <Trans>Let members use their own models with the built-in Thunderbolt agent.</Trans>
            </p>
          </div>
          <Switch
            id="allow-personal-models"
            checked={preview.state.policy.personalModelsAllowed}
            onCheckedChange={(personalModelsAllowed) =>
              preview.dispatch({ type: 'policy', patch: { personalModelsAllowed } })
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
