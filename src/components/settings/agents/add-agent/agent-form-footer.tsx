/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'

/** Keep wizard navigation in one predictable footer across all setup screens. */
export const AgentFormFooter = ({ onBack, children }: { onBack: () => void; children: ReactNode }) => {
  const { t } = useLingui()
  return (
    <FormFooter>
      <Button type="button" variant="ghost" size="icon" className="mr-auto" onClick={onBack} aria-label={t`Back`}>
        <ArrowLeft className="size-4" />
      </Button>
      {children}
    </FormFooter>
  )
}
