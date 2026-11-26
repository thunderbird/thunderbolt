/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AcpCompaction } from '@/acp/compaction'
import { useShowCompactionSummary } from '@/content-view/context'
import { CompactionNotice } from './compaction-notice'
import { acpCompactionSummary } from './compaction-summary'

/** Render remote lifecycle updates in place without treating them as local model checkpoints. */
export const AcpCompactionNotice = ({ compaction }: { compaction: AcpCompaction }) => {
  const showSummary = useShowCompactionSummary()
  const summary = acpCompactionSummary(compaction)
  const status =
    compaction.status === 'in_progress'
      ? 'compacting'
      : compaction.status === 'completed'
        ? 'compacted'
        : compaction.status === 'failed' || compaction.status === 'cancelled'
          ? compaction.status
          : 'unknown'
  return (
    <CompactionNotice
      status={status}
      error={compaction.error}
      onViewSummary={summary ? () => showSummary(summary) : undefined}
    />
  )
}
