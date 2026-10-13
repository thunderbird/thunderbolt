/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

export const PreviewResetAction = ({ onReset }: { onReset: () => void }) => {
  const { t } = useLingui()
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onReset}
      aria-label={t`Reset sample data`}
      title={t`Reset sample data`}
    >
      <RotateCcw />
    </Button>
  )
}
