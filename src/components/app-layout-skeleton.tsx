/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** A static placeholder, tinted like blurred text in both themes, because the layout must not pulse behind the spinner. */
const Placeholder = ({ className }: { className?: string }) => (
  <Skeleton className={cn('animate-none bg-foreground/10', className)} />
)

const iconSize = 'size-[var(--icon-size-default)]'
const composerControl = 'size-[var(--touch-height-control)] rounded-[var(--radius-control)]'

/**
 * A picture of the app's layout (sidebar, chat, composer) under a translucent layer, drawn behind the
 * offline wait message. It is plain markup with no data, no state and nothing to focus or click, so no
 * app code runs before the session is known.
 */
export const AppLayoutSkeleton = () => (
  <div
    data-testid="app-layout-skeleton"
    aria-hidden="true"
    inert
    className="absolute inset-0 -z-10 overflow-hidden bg-background animate-in fade-in duration-500 ease-out motion-reduce:animate-none"
  >
    {/* A blur filter, not a backdrop filter: Chrome drew a visible seam across a blurred backdrop. */}
    <div className="flex h-full blur-sm">
      <div className="hidden w-64 shrink-0 flex-col bg-sidebar px-2 pb-4 md:flex">
        <div className="flex h-[var(--touch-height-xl)] items-center justify-between px-2">
          <Placeholder className={iconSize} />
          <div className="flex gap-4">
            <Placeholder className={iconSize} />
            <Placeholder className={iconSize} />
            <Placeholder className={iconSize} />
          </div>
        </div>
        <div className="mt-2 flex h-8 items-center gap-3 px-2">
          <Placeholder className={iconSize} />
          <Placeholder className="h-3 w-20" />
        </div>
        <Placeholder className="mx-2 mt-8 h-2.5 w-16" />
        <Placeholder className="mx-2 mt-7 h-2.5 w-40" />
        <Placeholder className="mx-2 mt-12 h-2.5 w-16" />
        <div className="mt-5 flex h-8 items-center rounded-lg bg-sidebar-accent px-2">
          <Placeholder className="h-3 w-36" />
        </div>
        <Placeholder className="mx-2 mt-3 h-3 w-28" />
        <Placeholder className="mx-2 mt-5 h-3 w-32" />
        <Placeholder className={cn('mx-2 mt-auto', iconSize)} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[var(--touch-height-xl)] shrink-0 items-center justify-between px-3 md:justify-start md:gap-3 md:px-4">
          <Placeholder className="size-[var(--touch-height-lg)] rounded-full bg-sidebar md:hidden" />
          <Placeholder className="h-[var(--touch-height-lg)] w-24 rounded-full bg-sidebar md:hidden" />
          <Placeholder className={cn('max-md:hidden', iconSize)} />
          <Placeholder className="h-3 w-24 max-md:hidden" />
          <Placeholder className={cn('ml-4 max-md:hidden', iconSize)} />
        </div>
        <div className="mx-auto w-full min-w-0 max-w-[728px] flex-1 px-3 pt-6 md:px-4">
          <div className="ml-auto h-15 w-3/4 rounded-2xl bg-accent dark:bg-secondary/60" />
          <Placeholder className="mt-12 h-3 w-4/5" />
          <Placeholder className="mt-3 h-3 w-1/2" />
          <Placeholder className={cn('mt-6', iconSize)} />
        </div>
        <div className="shrink-0 px-3 pb-3 md:px-4 md:pb-4">
          <div className="mx-auto flex w-full max-w-[696px] flex-col gap-6 rounded-3xl bg-sidebar p-2 shadow-glow dark:shadow-none">
            <Placeholder className="mx-2 mt-3 h-3 w-32" />
            <div className="flex items-center justify-between">
              <Placeholder className={cn('mx-2', iconSize)} />
              <div className="flex items-center gap-4">
                <Placeholder className="h-3 w-16" />
                <div className={cn('bg-brand [background-image:var(--gradient-brand)]', composerControl)} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div className="absolute inset-0 bg-background/50 [@media(prefers-reduced-transparency:reduce)]:bg-background" />
  </div>
)
