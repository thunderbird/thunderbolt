/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'

type LoadMoreFooterProps = { hasMore: boolean; isLoading: boolean; onLoadMore: () => void }

/** "Load more" under a cursor-paged list. Renders nothing once the last page is in. */
export const LoadMoreFooter = ({ hasMore, isLoading, onLoadMore }: LoadMoreFooterProps) => {
  if (!hasMore) {
    return null
  }
  return (
    <div className="flex justify-center py-2">
      <Button type="button" variant="outline" size="sm" isLoading={isLoading} onClick={onLoadMore}>
        <Trans>Load more</Trans>
      </Button>
    </div>
  )
}
