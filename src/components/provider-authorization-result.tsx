/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { CircleMinus, Monitor } from 'lucide-react'
import { Link } from 'react-router'
import { AppLogo } from '@/components/app-logo'
import { AppWordmark } from '@/components/app-wordmark'
import { Button } from '@/components/ui/button'

/** Recovery for an invalid authorization return; successful flows resume setup directly. */
export const ProviderAuthorizationResult = () => {
  return (
    <div className="relative isolate flex min-h-svh w-full min-w-0 flex-col overflow-hidden bg-background">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -left-24 top-1/4 size-96 rounded-full bg-brand-2/10 blur-3xl" />
        <div className="absolute -right-24 bottom-0 size-96 rounded-full bg-brand/10 blur-3xl" />
      </div>
      <header className="flex shrink-0 justify-center px-6 py-6">
        <AppWordmark />
      </header>
      <main className="flex flex-1 items-center justify-center px-5 pb-12 pt-4">
        <section
          aria-labelledby="callback-heading"
          className="w-full max-w-md overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xl shadow-black/5"
        >
          <div aria-hidden="true" className="h-1 bg-[image:var(--gradient-brand)]" />
          <div className="flex flex-col items-center gap-7 px-6 py-9 sm:px-9">
            <div className="relative" aria-hidden="true">
              <div className="absolute inset-0 rounded-full bg-[image:var(--gradient-brand)] opacity-15 blur-2xl" />
              <div className="relative flex size-24 items-center justify-center rounded-2xl border border-border/60 bg-background">
                <AppLogo size={56} alt="" />
              </div>
              <div className="absolute -bottom-2 -right-2 rounded-full bg-card p-1.5">
                <CircleMinus className="size-7 text-muted-foreground" />
              </div>
            </div>
            <div className="flex flex-col items-center gap-3 text-center">
              <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                <Trans>Try connecting again</Trans>
              </p>
              <h1 id="callback-heading" className="text-balance font-heading text-3xl tracking-tight">
                <Trans>Connection not completed</Trans>
              </h1>
              <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
                <Trans>
                  This connection link is no longer valid. Return to Thunderbolt and start a new connection.
                </Trans>
              </p>
            </div>
            <div className="flex w-full flex-col gap-3">
              <Button asChild className="w-full">
                <Link to="/chats/new" replace>
                  <Trans>Return to Thunderbolt</Trans>
                </Link>
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-center gap-2 border-t border-border/60 bg-muted/30 px-6 py-4 text-xs text-muted-foreground">
            <Monitor className="size-4 shrink-0" aria-hidden="true" />
            <Trans>Continue in your Thunderbolt window</Trans>
          </div>
        </section>
      </main>
    </div>
  )
}
