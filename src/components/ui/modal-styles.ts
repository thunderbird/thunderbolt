/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const modalAnimationClass =
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'

export const modalOverlayClass = `${modalAnimationClass} fixed inset-0 z-50 bg-black/50 backdrop-blur-md max-md:backdrop-blur-lg max-md:backdrop-saturate-[.25]`

export const modalCloseClass =
  'ring-offset-background focus:ring-ring absolute z-10 flex size-[var(--touch-height-sm)] cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none'

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
