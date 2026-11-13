/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { PageHeader } from '@/components/ui/page-header'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent } from '@/components/ui/card'
import { SettingsPageShell } from '@/components/settings/settings-list'
import { MemoryConnections } from '@/settings/memory-connections'
import { useCreateItem } from '@/components/create-item/context'
import { useMemorySettingsState } from './use-memory-settings-state'

const MemorySettingsPage = () => {
  const { t } = useLingui()
  const page = useMemorySettingsState()
  const { openCreateItem } = useCreateItem()
  const memoryDisabled = !page.memoryEnabled.value || page.memoryEnabled.isLoading
  return (
    <SettingsPageShell className="gap-8 md:gap-10 md:pb-12">
      <PageHeader title={t`Memory`} />
      <Card>
        <CardContent className="space-y-6">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label htmlFor="memory-enabled" className="text-sm font-medium">
                <Trans>Saved memories</Trans>
              </label>
              <p className="text-sm text-muted-foreground">
                <Trans>Allow agents to recall and share info across sessions.</Trans>
              </p>
            </div>
            <Switch
              id="memory-enabled"
              aria-label={t`Saved memories`}
              checked={page.memoryEnabled.value}
              onCheckedChange={page.toggleMemory}
              disabled={page.pending || page.memoryEnabled.isLoading}
            />
          </div>
          <div className="-mx-6 h-px bg-border" />
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label htmlFor="session-history-enabled" className="text-sm font-medium">
                <Trans>Reference earlier chats</Trans>
              </label>
              <p className="text-sm text-muted-foreground">
                <Trans>Allow agents to view previous chat sessions.</Trans>
              </p>
            </div>
            <Switch
              id="session-history-enabled"
              aria-label={t`Reference earlier chats`}
              checked={page.sessionHistoryEnabled.value}
              onCheckedChange={page.toggleHistory}
              disabled={page.pending || page.sessionHistoryEnabled.isLoading}
            />
          </div>
        </CardContent>
      </Card>
      <fieldset
        disabled={memoryDisabled}
        aria-labelledby="memory-provider-heading"
        className="flex min-w-0 flex-col gap-8 disabled:opacity-50 md:gap-10"
      >
        <MemoryConnections
          selectedProvider={page.memoryProvider.value}
          onSelect={page.selectProvider}
          disabled={memoryDisabled || page.pending || page.preview !== null || page.memoryProvider.isLoading}
          builtinMemory={{
            content: page.content,
            isLoading: page.isLoading,
            onEdit: () => openCreateItem({ kind: 'memory', initialEditContent: page.content }),
            onView: () => openCreateItem({ kind: 'memory' }),
          }}
        />
        {page.error && page.preview === null && (
          <p role="alert" className="text-sm text-destructive">
            {page.error}
          </p>
        )}
      </fieldset>
    </SettingsPageShell>
  )
}
export default MemorySettingsPage
