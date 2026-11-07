/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'

export const AgentTags = ({ items }: { items: string[] }) =>
  items.length ? (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item} className="rounded-md bg-muted px-2 py-1 text-sm">
          {item}
        </span>
      ))}
    </div>
  ) : (
    <span className="text-sm text-muted-foreground">
      <Trans>None</Trans>
    </span>
  )
