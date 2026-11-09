/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { DetailDivider, DetailSectionTitle } from '@/components/detail-panel'
import { FieldLabel } from './editable-field'

type UsageResource = {
  label: string
  summary: ReactNode
  to: string
}

/** Shared read-only description and library links for the built-in agent. */
export const AgentUsageSummary = ({ about, resources }: { about: ReactNode; resources: UsageResource[] }) => (
  <>
    <div className="flex shrink-0 flex-col gap-2">
      <DetailSectionTitle>
        <Trans>About</Trans>
      </DetailSectionTitle>
      <p className="text-base leading-snug text-foreground">{about}</p>
    </div>

    <DetailDivider />

    <div className="flex flex-col gap-4">
      <DetailSectionTitle>
        <Trans>What it uses</Trans>
      </DetailSectionTitle>
      <div className="flex flex-col gap-4">
        {resources.map((resource) => (
          <div key={resource.label} className="flex flex-col gap-1">
            <FieldLabel>{resource.label}</FieldLabel>
            <Link
              to={resource.to}
              className="w-fit text-base text-primary underline underline-offset-4 transition-colors hover:text-foreground"
            >
              {resource.summary}
            </Link>
          </div>
        ))}
      </div>
    </div>
  </>
)
