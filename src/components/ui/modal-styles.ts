/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const modalAnimationClass =
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'

export const modalOverlayClass = `${modalAnimationClass} fixed inset-0 z-50 bg-black/50 backdrop-blur-md max-md:backdrop-blur-lg max-md:backdrop-saturate-[.25]`

/**
 * Resting fill for the header icon controls — the app header's sidebar toggle,
 * the modal close X, the ⋯ actions menu — on touch viewports: with no hover to
 * reveal it, the filled circle is the only cue for where the tap target is, so
 * it stays painted. Desktop keeps the hover-only reveal. Pair it with
 * `mutedIconButtonClass` on anything that isn't already the shared close
 * control.
 *
 * The fill is translucent and frosted rather than solid, since content now
 * scrolls underneath these controls. At 80% over the page background it reads as
 * flat `bg-muted` — the two tokens are within a few values of each other — so the
 * translucency only shows itself once there's content behind it.
 *
 * The deeper press fill carries the same `max-md:` prefix on purpose — Tailwind
 * emits media-query utilities after plain state variants, so an unprefixed
 * `active:bg-*` would lose to the resting fill here and the tap would land with
 * no feedback at all.
 *
 * Dark mode halves the resting fill: dark `--muted` sits far from the page
 * background, so the full 80% circle reads too loud there — 40% keeps the tap
 * target visible while staying subtle.
 */
export const mobileHeaderControlFillClass =
  'max-md:bg-muted/80 max-md:dark:bg-muted/40 max-md:backdrop-blur-md max-md:active:bg-muted-foreground/20'

/**
 * Descendant-selector variant of `mobileHeaderControlFillClass` for containers
 * whose buttons arrive as an opaque `actions` ReactNode (e.g. the content-view
 * header's `ResponsiveModalActions`). Tailwind needs literal class names, so
 * the fill tokens are restated with `[&>button]:` prefixes — keep the two
 * constants in sync. No `max-md:` gate: these containers only render on
 * mobile.
 */
export const mobileHeaderControlFillDescendantClass =
  '[&>button]:size-[var(--touch-height-lg)] [&>button]:bg-muted/80 dark:[&>button]:bg-muted/40 [&>button]:backdrop-blur-md [&>button]:active:bg-muted-foreground/20'

/**
 * Ring is keyed on focus-visible, matching the Button primitive (and
 * mutedIconButtonClass, this control's desktop twin). A plain `focus:` ring
 * would paint whenever Radix moves focus here on mount — which happens in any
 * modal whose body has no other tabbable element, e.g. a read-only agent
 * detail — leaving a touch-opened modal looking keyboard-focused.
 */
export const modalCloseClass = `${mobileHeaderControlFillClass} absolute z-10 flex size-[var(--touch-height-lg)] md:size-[var(--touch-height-sm)] cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none`

export const centeredModalSurfaceClass = `${modalAnimationClass} data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-2xl bg-background shadow-lg duration-200 dark:bg-card`

/*
 * Field-surface restyles: lift the four field slots (input, textarea, select
 * and combobox triggers) off an elevated surface. Two variants because the
 * surfaces differ — modals sit on bg-background/dark bg-card, the slide-in
 * detail panel sits on bg-sidebar — so each picks the contrast color for its
 * own backdrop. Dark mode converges on bg-input for both.
 */

export const modalFieldSurfaceClass =
  '[&_[data-slot=input]]:!bg-card [&_[data-slot=textarea]]:!bg-card [&_[data-slot=select-trigger]]:!bg-card [&_[data-slot=combobox-trigger]]:!bg-card dark:[&_[data-slot=input]]:!bg-input dark:[&_[data-slot=textarea]]:!bg-input dark:[&_[data-slot=select-trigger]]:!bg-input dark:[&_[data-slot=combobox-trigger]]:!bg-input'

export const panelFieldSurfaceClass =
  '[&_[data-slot=input]]:bg-background [&_[data-slot=textarea]]:bg-background [&_[data-slot=select-trigger]]:bg-background [&_[data-slot=combobox-trigger]]:bg-background dark:[&_[data-slot=input]]:bg-input dark:[&_[data-slot=textarea]]:bg-input dark:[&_[data-slot=select-trigger]]:bg-input dark:[&_[data-slot=combobox-trigger]]:bg-input'
