/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { BackButton } from '@/components/ui/back-button'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'

/** Navigation for a connection selected from the add picker. */
export const ConnectionSetupFooter = ({
  onBack,
  onContinue,
  ready,
}: {
  onBack: () => void
  onContinue: () => void
  ready: boolean
}) => (
  <FormFooter className="items-center justify-between">
    <BackButton onClick={onBack} />
    <Button onClick={onContinue} disabled={!ready}>
      <Trans>Continue</Trans>
    </Button>
  </FormFooter>
)
