/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural, Trans } from '@lingui/react/macro'
import { ListSkeleton } from '../../components/list-skeleton'
import { LoadMoreFooter } from '../../components/load-more-footer'
import { RoleMappingControl } from '../../components/role-mapping-control'
import { useScimGroups } from './use-connection-queries'
import { InlineError } from '../../components/inline-error'

/**
 * The groups the identity provider pushed over SCIM. Read-only apart from their role mapping, which
 * names the group by id: renaming it in the provider changes nothing here.
 */
export const ScimGroupsSection = ({ connectionId, canMap }: { connectionId: string; canMap: boolean }) => {
  const groups = useScimGroups(connectionId)

  const list = () => {
    if (groups.isLoading) {
      return <ListSkeleton rows={3} />
    }
    if (groups.error && groups.items.length === 0) {
      return <InlineError error={groups.error} />
    }
    if (groups.isEmpty) {
      return (
        <p className="text-muted-foreground">
          <Trans>Your identity provider hasn't pushed any groups yet.</Trans>
        </p>
      )
    }
    return (
      <ul className="flex flex-col divide-y">
        {groups.items.map((group) => (
          <li key={group.id} aria-label={group.displayName} className="flex flex-col gap-3 py-3">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{group.displayName}</span>
              <span className="flex flex-wrap gap-x-3 text-[length:var(--font-size-sm)] text-muted-foreground">
                <code className="break-all">{group.id}</code>
                <span>
                  <Plural value={group.memberCount} one="# member" other="# members" />
                </span>
              </span>
            </div>
            <RoleMappingControl
              target={{ identityConnectionId: connectionId, scimGroupId: group.id }}
              groupName={group.displayName}
              disabled={!canMap}
            />
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">
        <Trans>
          Your identity provider owns these groups. A mapping follows the group's ID, so renaming it there changes
          nothing here.
        </Trans>
      </p>
      {list()}
      <LoadMoreFooter hasMore={groups.hasMore} isLoading={groups.isLoadingMore} onLoadMore={groups.loadMore} />
    </div>
  )
}
