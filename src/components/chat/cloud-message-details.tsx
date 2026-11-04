/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Link } from 'react-router'
import { FileText } from 'lucide-react'
import type { UIMessageMetadata } from '@/types'

const statusLabels = {
  queued: msg`Queued`,
  running: msg`Working`,
  'awaiting-approval': msg`Waiting for approval`,
  'stop-requested': msg`Stopping…`,
  stopped: msg`Stopped`,
  failed: msg`Failed`,
  blocked: msg`Needs attention`,
  uncertain: msg`Action outcome unknown`,
}

/** Durable status and saved files belong beside the ordinary assistant response. */
export const CloudMessageDetails = ({ cloud }: { cloud: UIMessageMetadata['cloud'] }) => {
  const { i18n } = useLingui()
  if (!cloud || (cloud.status === 'completed' && !cloud.artifactIds?.length)) {
    return null
  }
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-8">
      {cloud.status !== 'completed' && (
        <span role="status" className="text-sm text-muted-foreground">
          {i18n._(statusLabels[cloud.status])}
        </span>
      )}
      {cloud.artifactIds?.map((id) => (
        <Link
          key={id}
          to={`/artifacts?${new URLSearchParams({ artifact: id })}`}
          className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-secondary"
        >
          <FileText className="size-4" />
          <Trans>Open artifact</Trans>
        </Link>
      ))}
    </div>
  )
}
