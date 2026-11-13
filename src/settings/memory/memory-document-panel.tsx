/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { ArrowRight, Check, Copy, SquarePen, Sparkles } from 'lucide-react'
import { AppLogo } from '@/components/app-logo'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { FormFooter } from '@/components/ui/form-footer'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { canCompactMemories } from '@/memory/compact'
import { maxMemoryBytes, memoryCharacterLength } from '@/memory/limits'
import { MemoryDocument } from './memory-document'
import { useMemorySettingsState } from './use-memory-settings-state'

type MemoryDocumentPanelProps = {
  open: boolean
  onClose: () => void
  onCloseComplete: () => void
  initialEditContent?: string
}

/** View and edit built-in memory in the same route-preserving surface as connected providers. */
export const MemoryDocumentPanel = ({
  open,
  onClose,
  onCloseComplete,
  initialEditContent,
}: MemoryDocumentPanelProps) => {
  const { t } = useLingui()
  const page = useMemorySettingsState({ initialEditContent })
  const disabled = !page.memoryEnabled.value || page.memoryEnabled.isLoading
  const full = page.usage.bytes > maxMemoryBytes
  const close = () => {
    if (!page.pending) {
      onClose()
    }
  }
  return (
    <>
      <DetailPanelSurface open={open} onClose={close} onCloseComplete={onCloseComplete} topInset>
        <DetailPanel
          title={t`Built-in memory`}
          icon={<AppLogo size={24} alt="" />}
          onClose={close}
          bodyLayout="fill"
          actions={
            <DetailActionsMenu>
              <DropdownMenuItem
                onClick={page.startEditing}
                disabled={disabled || page.pending || page.isLoading || !!page.edit}
                className="cursor-pointer"
              >
                <SquarePen />
                <Trans>Edit</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={page.compact}
                aria-busy={page.compacting}
                disabled={
                  disabled ||
                  page.pending ||
                  page.isLoading ||
                  !!page.edit ||
                  !page.model ||
                  !canCompactMemories(page.content)
                }
                className="cursor-pointer"
              >
                <Sparkles />
                {page.compacting ? <Trans>Compacting…</Trans> : <Trans>Compact</Trans>}
              </DropdownMenuItem>
            </DetailActionsMenu>
          }
        >
          <fieldset disabled={disabled} className="flex min-h-0 flex-1 flex-col gap-4 disabled:opacity-50">
            {page.edit ? (
              <Textarea
                aria-label={t`Memory text`}
                aria-describedby="memory-size"
                placeholder={t`Add things you want your agent to remember.`}
                value={page.text}
                readOnly={page.pending}
                onChange={(event) => page.changeDraft(event.target.value)}
                className="min-h-96 flex-1 resize-none whitespace-pre-wrap leading-relaxed"
                autoFocus
              />
            ) : (
              <div
                role="document"
                aria-label={t`Memory text`}
                className="min-w-0 flex-1 select-text break-words text-sm leading-relaxed text-foreground/80"
              >
                {page.isLoading ? (
                  <span className="text-muted-foreground">
                    <Trans>Loading memory…</Trans>
                  </span>
                ) : page.content ? (
                  <MemoryDocument content={page.content} />
                ) : (
                  <span className="text-muted-foreground">
                    <Trans>No memory yet. Click Edit or ask your agent to remember something.</Trans>
                  </span>
                )}
              </div>
            )}
            {full && (
              <p role="status" className="text-sm text-destructive">
                <Trans>Memory is too long. Shorten it before saving.</Trans>
              </p>
            )}
            {page.error && (
              <p role="alert" className="text-sm text-destructive">
                {page.error}
              </p>
            )}
            <div className="flex shrink-0 items-center justify-between gap-3 pb-2">
              <p id="memory-size" className={full ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                <Plural value={page.usage.characters} one="# character" other="# characters" />
              </p>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground/80"
                title={page.isCopied ? t`Copied` : t`Copy`}
                aria-label={page.isCopied ? t`Copied` : t`Copy`}
                onClick={page.copy}
                disabled={!page.text || page.isLoading}
              >
                {page.isCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </fieldset>
          {page.edit && (
            <FormFooter>
              <Button variant="ghost" size="sm" onClick={page.cancel} disabled={disabled || page.pending}>
                <Trans>Cancel</Trans>
              </Button>
              <Button
                size="sm"
                onClick={page.save}
                disabled={disabled || page.pending || full || page.edit.draft === page.edit.before}
              >
                <Trans>Save</Trans>
              </Button>
            </FormFooter>
          )}
        </DetailPanel>
      </DetailPanelSurface>
      <Dialog
        open={page.preview !== null}
        onOpenChange={(open) => {
          if (!open && !page.pending) {
            page.patch({ preview: null, error: null })
          }
        }}
      >
        <DialogContent aria-describedby={undefined} className="flex max-h-[85dvh] flex-col gap-6 sm:max-w-4xl">
          <DialogHeader className="shrink-0 pr-8 text-left">
            <DialogTitle>
              <Trans>Review compacted memory</Trans>
            </DialogTitle>
          </DialogHeader>
          <div className="grid min-h-0 gap-3 overflow-y-auto text-sm md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <section aria-labelledby="memory-before-title" className="min-w-0 rounded-xl border bg-muted/30">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                <h3 id="memory-before-title" className="font-medium">
                  <Trans>Current memory</Trans>
                </h3>
                <span className="text-xs text-muted-foreground">
                  <Plural
                    value={memoryCharacterLength(page.preview?.before ?? '')}
                    one="# character"
                    other="# characters"
                  />
                </span>
              </div>
              <div className="min-h-48 break-words p-4 leading-relaxed text-muted-foreground">
                <MemoryDocument content={page.preview?.before ?? ''} />
              </div>
            </section>
            <div aria-hidden="true" className="flex items-center justify-center text-muted-foreground">
              <ArrowRight className="size-5 rotate-90 md:rotate-0" />
            </div>
            <section
              aria-labelledby="memory-after-title"
              className="min-w-0 rounded-xl border border-primary/20 bg-primary/5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/20 px-4 py-3">
                <h3 id="memory-after-title" className="font-medium">
                  <Trans>Proposed memory</Trans>
                </h3>
                <span className="text-xs text-muted-foreground">
                  <Plural
                    value={memoryCharacterLength(page.preview?.after ?? '')}
                    one="# character"
                    other="# characters"
                  />
                </span>
              </div>
              <div className="min-h-48 break-words p-4 leading-relaxed text-foreground/80">
                <MemoryDocument content={page.preview?.after ?? ''} />
              </div>
            </section>
          </div>
          {page.error && (
            <p role="alert" className="text-sm text-destructive">
              {page.error}
            </p>
          )}
          <DialogFooter className="shrink-0">
            <Button variant="ghost" disabled={page.pending} onClick={() => page.patch({ preview: null, error: null })}>
              <Trans>Cancel</Trans>
            </Button>
            <Button disabled={disabled || page.pending} onClick={page.apply}>
              <Trans>Apply</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
