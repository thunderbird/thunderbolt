/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { CloudAgentClient } from '@/cloud-agent/client'
import type { CloudOutboxEntry } from '@/cloud-agent/offline'
import { Button } from '@/components/ui/button'
import { CloudError } from './common'

const QueuedAgentPreview = ({ client, entry }: { client: CloudAgentClient; entry: CloudOutboxEntry }) => {
  const saved = useQuery({
    queryKey: ['cloud-agents', entry.userId, 'queued-config', entry.id],
    queryFn: () => client.queuedAgentConfig(entry),
    networkMode: 'always',
  })
  return (
    <details className="max-w-full text-xs">
      <summary className="cursor-pointer">
        <Trans>Review saved configuration</Trans>
      </summary>
      {saved.data && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-secondary p-2">
          {JSON.stringify(saved.data, null, 2)}
        </pre>
      )}
      <CloudError error={saved.error} />
    </details>
  )
}

export const CloudOutbox = ({
  client,
  entries,
  refresh,
}: {
  client: CloudAgentClient
  entries: CloudOutboxEntry[]
  refresh: () => Promise<unknown>
}) => {
  const discard = useMutation({ mutationFn: client.discardQueued, onSuccess: refresh, networkMode: 'always' })
  const retry = useMutation({ mutationFn: () => client.flushOutbox(), onSuccess: refresh, networkMode: 'always' })
  if (entries.length === 0) {
    return null
  }
  return (
    <section className="space-y-2 rounded-xl border p-3" aria-live="polite">
      <h3 className="text-sm font-medium">
        <Trans>Saved on this device</Trans>
      </h3>
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-center justify-between gap-3 text-sm">
          <div className="min-w-0">
            {entry.kind === 'message' ? (
              <Trans>Message waiting to send</Trans>
            ) : (
              <Trans>Agent configuration waiting to save</Trans>
            )}
            {entry.status === 'needs-review' && (
              <span className="block text-destructive">
                {entry.errorCode === '409' ? (
                  <Trans>
                    A newer version exists. Your saved copy has been kept; discard it and reopen the agent to review the
                    current version.
                  </Trans>
                ) : (
                  <Trans>The server rejected this change. Review the current configuration before trying again.</Trans>
                )}
              </span>
            )}
            {entry.kind === 'agent-save' && <QueuedAgentPreview client={client} entry={entry} />}
          </div>
          <Button size="sm" variant="ghost" disabled={discard.isPending} onClick={() => discard.mutate(entry.id)}>
            <Trans>Discard</Trans>
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}>
        <Trans>Retry queued changes</Trans>
      </Button>
      <CloudError error={discard.error ?? retry.error} />
    </section>
  )
}
