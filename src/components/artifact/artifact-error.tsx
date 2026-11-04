/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@/components/ui/alert'

/** Keep artifact failures visible without disrupting the rest of the library. */
export const ArtifactError = ({ error }: { error: unknown }) =>
  error ? (
    <Alert variant="destructive">
      <AlertDescription>
        {error instanceof Error ? error.message : <Trans>The request failed. Please try again.</Trans>}
      </AlertDescription>
    </Alert>
  ) : null
