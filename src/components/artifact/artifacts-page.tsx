/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { AppWindow, FileText, RefreshCw } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router'
import { useAuth } from '@/contexts'
import { useSignInModal } from '@/contexts/sign-in-modal-context'
import { SettingsListBody, SettingsListPane, SettingsSelectableRow } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { PageSearch } from '@/components/ui/page-search'
import { SyncSetupModal } from '@/components/sync-setup/sync-setup-modal'
import { useFormatters } from '@/i18n/use-formatters'
import { toDate } from '@/i18n/format'
import { artifactLocation, artifactSelection, type ArtifactSelection } from '@/artifacts/library'
import { ArtifactError } from './artifact-error'
import { useArtifactsState } from './use-artifacts-state'
import { SnapshotArtifactDetails } from './snapshot-artifacts'
import { MessageArtifactDetails } from './message-artifact-details'

const ArtifactLibrary = ({ ownerId }: { ownerId: string | null }) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const { openSignInModal } = useSignInModal()
  const state = useArtifactsState(ownerId)
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const selection = artifactSelection(search)
  const local =
    selection?.kind === 'message' ? state.local.artifacts.find((item) => item.id === selection.id) : undefined
  const snapshot =
    selection?.kind === 'snapshot' ? state.snapshots.data?.find((item) => item.artifact.id === selection.id) : undefined
  const items = [
    ...state.local.artifacts.map((item) => ({
      selection: { kind: 'message', id: item.id } as ArtifactSelection,
      title: item.title ?? t`Artifact`,
      subtitle: item.chatTitle ? t`From ${item.chatTitle}` : t`From a chat`,
      date: item.createdAt,
    })),
    ...(state.snapshots.data ?? []).map((item) => {
      const head =
        item.revisions.find(({ record }) => record.id === item.artifact.currentRevisionId) ?? item.revisions[0]
      return {
        selection: { kind: 'snapshot', id: item.artifact.id } as ArtifactSelection,
        title: head?.manifest.title ?? t`Artifact`,
        subtitle: t`Saved artifact`,
        date: toDate(head?.record.createdAt ?? item.artifact.createdAt),
      }
    }),
  ].sort((a, b) => b.date.getTime() - a.date.getTime())
  const term = state.view.search.trim().toLocaleLowerCase()
  const visible = term
    ? items.filter((item) => `${item.title} ${item.subtitle}`.toLocaleLowerCase().includes(term))
    : items
  const close = () => navigate(artifactLocation())
  return (
    <div className="relative flex h-full min-w-0 md:pt-[var(--header-inset)]">
      <SettingsListPane>
        <PageSearch onSearch={(value) => state.patch({ search: value })}>
          <PageHeader title={t`Artifacts`}>
            <PageSearch.Button />
            <Button variant="ghost" size="icon" aria-label={t`Refresh artifacts`} onClick={() => state.refresh()}>
              <RefreshCw />
            </Button>
          </PageHeader>
          <PageSearch.Input placeholder={t`Search artifacts…`} onSearch={(value) => state.patch({ search: value })} />
        </PageSearch>
        <SettingsListBody>
          {!state.online && (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>You’re offline. Previously downloaded artifacts are available.</Trans>
            </p>
          )}
          <ArtifactError
            error={state.local.error ?? state.snapshots.error ?? state.ready.error ?? state.completeSetup.error}
          />
          {local ? (
            <MessageArtifactDetails key={local.id} artifact={local} onBack={close} />
          ) : snapshot && state.client && ownerId ? (
            <SnapshotArtifactDetails
              key={snapshot.artifact.id}
              client={state.client}
              ownerId={ownerId}
              artifact={snapshot}
              onBack={close}
            />
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                <Trans>Find your saved work across chats and agents.</Trans>
              </p>
              {selection && (
                <Button variant="ghost" size="sm" className="self-start" onClick={close}>
                  <Trans>All artifacts</Trans>
                </Button>
              )}
              {(state.local.isLoading || state.snapshots.isLoading) && (
                <p className="text-sm text-muted-foreground">
                  <Trans>Loading artifacts…</Trans>
                </p>
              )}
              {selection && !state.local.isLoading && !state.snapshots.isLoading && (
                <p role="status" className="text-sm text-muted-foreground">
                  <Trans>This artifact is not available on this device.</Trans>
                </p>
              )}
              {visible.map((item) => (
                <SettingsSelectableRow
                  key={`${item.selection.kind}:${item.selection.id}`}
                  title={item.title}
                  subtitle={
                    <>
                      {item.subtitle} · {formatters.date(item.date)}
                    </>
                  }
                  leading={
                    item.selection.kind === 'message' ? (
                      <AppWindow className="size-5" />
                    ) : (
                      <FileText className="size-5" />
                    )
                  }
                  ariaLabel={t`Open ${item.title}`}
                  onSelect={() => navigate(artifactLocation(item.selection))}
                />
              ))}
              {visible.length === 0 && !state.local.isLoading && !state.snapshots.isLoading && (
                <p className="py-8 text-center text-muted-foreground">
                  {term ? (
                    <Trans>No matching artifacts.</Trans>
                  ) : (
                    <Trans>Artifacts you create in chats and save to your account will appear here.</Trans>
                  )}
                </p>
              )}
              {!ownerId && (
                <div className="flex flex-col items-start gap-3 border-t pt-4">
                  <p className="text-sm text-muted-foreground">
                    <Trans>Sign in to see artifacts saved to your account.</Trans>
                  </p>
                  <Button variant="outline" onClick={openSignInModal}>
                    <Trans>Sign in</Trans>
                  </Button>
                </div>
              )}
              {ownerId && state.ready.data === false && (
                <div className="flex flex-col items-start gap-3 border-t pt-4">
                  <p className="text-sm text-muted-foreground">
                    <Trans>Set up encrypted sync on this device to open artifacts saved to your account.</Trans>
                  </p>
                  <Button variant="outline" onClick={() => state.patch({ setupOpen: true })}>
                    <Trans>Set up encrypted sync</Trans>
                  </Button>
                </div>
              )}
            </>
          )}
        </SettingsListBody>
        <SyncSetupModal
          open={state.view.setupOpen}
          onOpenChange={(setupOpen) => state.patch({ setupOpen })}
          onComplete={() => state.completeSetup.mutate()}
        />
      </SettingsListPane>
    </div>
  )
}

/** One library for existing chat artifacts and independent encrypted snapshot resources. */
export const ArtifactsPage = () => {
  const auth = useAuth()
  const { data: session } = auth.useSession()
  const ownerId = session?.user.id && !session.user.isAnonymous ? session.user.id : null
  return <ArtifactLibrary key={ownerId ?? 'local'} ownerId={ownerId} />
}
