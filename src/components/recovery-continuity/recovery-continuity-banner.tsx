/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { GradientCircleCheck } from '@/components/ui/gradient-circle-check'
import { MobileForegroundPortalProvider } from '@/components/ui/mobile-foreground-portal'
import { useSidebar } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { isMacDesktop, isTauriDesktop } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { Trans, useLingui } from '@lingui/react/macro'
import { Info, ShieldAlert, WifiOff, X } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { useRecoveryContinuity, type RecoveryContinuityContextValue } from './recovery-continuity-provider'

type BannerKind = 'warning' | 'offline' | 'updatedHere' | 'updatedElsewhere'

/** Which banner shows, if any. It covers only the phrase; the passkey's status lives in the Preferences card. */
const bannerKind = ({ status, notice, deviceTrusted }: RecoveryContinuityContextValue): BannerKind | null => {
  if (deviceTrusted && (notice === 'updatedHere' || notice === 'updatedElsewhere')) {
    return notice
  }
  return status === 'warning' || status === 'offline' ? status : null
}

/**
 * Header geometry for the column below a shown banner. The banner already
 * covers the top safe area, so the floating header must not pad for it again.
 * The derived variables are computed on `:root`, so each one is redefined here.
 */
const bannerColumnOverrides = {
  '--header-safe-area-top': '0px',
  '--header-inset': 'var(--touch-height-xl)',
  '--header-control-top': 'var(--modal-control-inset)',
  '--modal-top-inset': 'calc(var(--modal-control-inset) + var(--touch-height-lg))',
} as CSSProperties

type BannerShellProps = {
  icon: ReactNode
  title: ReactNode
  description: ReactNode
  actions: ReactNode
  /** One row on mobile: the description is visually hidden and left to the dialog the action opens. */
  compact?: boolean
}

const BannerShell = ({ icon, title, description, actions, compact }: BannerShellProps) => {
  const { t } = useLingui()
  const { isMobile } = useIsMobile()
  const { state: sidebarState } = useSidebar()
  // Same rules as the floating header: the macOS traffic lights overhang a
  // collapsed sidebar, and both desktop apps drag the window by their top row.
  const needsTrafficLightClearance = isMacDesktop() && !isMobile && sidebarState === 'collapsed'
  const dragProps = isTauriDesktop() ? { 'data-tauri-drag-region': true } : {}

  return (
    <section
      {...dragProps}
      aria-label={t`Security notice`}
      className={cn(
        'relative z-40 flex shrink-0 gap-2 border-b border-border bg-card px-4 pb-2 md:flex-row md:items-center md:gap-4',
        compact ? 'flex-row items-center' : 'flex-col',
      )}
      style={{ paddingTop: 'calc(var(--header-safe-area-top) + 0.5rem)' }}
    >
      <div
        className={cn(
          'flex min-w-0 flex-1 gap-3 md:items-center',
          compact ? 'items-center' : 'items-start',
          needsTrafficLightClearance && 'ml-8',
        )}
      >
        <span className={cn('shrink-0 md:mt-0', !compact && 'mt-0.5')}>{icon}</span>
        <p className="min-w-0 text-[length:var(--font-size-sm)] text-muted-foreground" role="status">
          <span className="font-medium text-foreground">{title}</span>{' '}
          <span className={cn(compact && 'max-md:sr-only')}>{description}</span>
        </p>
      </div>
      <div className={cn('flex shrink-0 items-center gap-2', !compact && 'pl-7 md:pl-0')}>{actions}</div>
    </section>
  )
}

/**
 * A compact strip across the top of the content column while this trusted
 * device can update a recovery phrase that has no continuity seal, and for the
 * session's phrase-update notices. It is not modal and takes no focus; its
 * action opens the phrase-change dialogs in place. It cannot be dismissed while
 * the update is still needed.
 */
export const RecoveryContinuityBanner = () => {
  const { t } = useLingui()
  const navigate = useNavigate()
  const continuity = useRecoveryContinuity()
  const kind = bannerKind(continuity)
  if (!kind) {
    return null
  }

  const dismiss = (
    <Button variant="ghost" size="icon-sm" onClick={continuity.dismissNotice} aria-label={t`Dismiss`}>
      <X className="size-[var(--icon-size-sm)]" aria-hidden />
    </Button>
  )

  if (kind === 'updatedHere') {
    return (
      <BannerShell
        icon={<GradientCircleCheck className="size-[var(--icon-size-default)]" />}
        title={<Trans>Recovery phrase updated.</Trans>}
        description={<Trans>Your new phrase is the only one that works now. Keep it somewhere safe.</Trans>}
        actions={dismiss}
      />
    )
  }

  if (kind === 'updatedElsewhere') {
    return (
      <BannerShell
        icon={<Info className="size-[var(--icon-size-default)] text-muted-foreground" aria-hidden />}
        title={<Trans>Your recovery phrase was updated on another device.</Trans>}
        description={
          <Trans>Use the new phrase you saved there; the old one no longer works. Not you? Review your devices.</Trans>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate('/settings/devices')}>
              <Trans>Review devices</Trans>
            </Button>
            {dismiss}
          </>
        }
      />
    )
  }

  const online = kind === 'warning'
  return (
    <BannerShell
      compact={online}
      icon={
        online ? (
          <ShieldAlert className="size-[var(--icon-size-default)] text-warning" aria-hidden />
        ) : (
          <WifiOff className="size-[var(--icon-size-default)] text-warning" aria-hidden />
        )
      }
      title={<Trans>Update your recovery phrase.</Trans>}
      description={
        online ? (
          <Trans>
            It was created before a security update. A new phrase lets recovery confirm your keys are yours.
          </Trans>
        ) : (
          <Trans>You're offline. You can update it once you reconnect.</Trans>
        )
      }
      actions={
        <Button size="sm" disabled={!online} onClick={() => void continuity.start()}>
          <Trans>Update now</Trans>
        </Button>
      }
    />
  )
}

/**
 * The content column with the banner above it. While the banner shows, the
 * column below redefines the header geometry so nothing pads twice for the top
 * safe area. On mobile it also contains `fixed` descendants, and hosts the
 * portal for page titles and the search button, so that chrome sits below the
 * banner instead of under it. With no banner, nothing changes. The portal is
 * always mounted so the page doesn't remount when the banner comes or goes.
 */
export const RecoveryContinuityColumn = ({ children }: { children: ReactNode }) => {
  const shows = bannerKind(useRecoveryContinuity()) !== null
  return (
    <>
      <RecoveryContinuityBanner />
      <div
        className={cn('relative flex min-h-0 flex-1 flex-col', shows && 'max-md:[contain:layout]')}
        style={shows ? bannerColumnOverrides : undefined}
      >
        <MobileForegroundPortalProvider>{children}</MobileForegroundPortalProvider>
      </div>
    </>
  )
}
