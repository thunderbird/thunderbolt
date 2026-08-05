/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

/** Surface-neutral footer that stays at the bottom of a flex form. */
export const FormFooter = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    data-slot="form-footer"
    className={cn('mt-auto flex shrink-0 flex-row justify-end gap-2 pt-4', className)}
    {...props}
  />
)

/**
 * Mobile treatment for a `FormFooter` nested anywhere inside a scrolling panel:
 * pin the actions to the panel frame and soften the content passing
 * behind them, so they read as floating over the body rather than sitting in a
 * bar. The footer itself stays transparent.
 *
 * The scrim is the `FloatingHeader` treatment inverted: a background fade plus a
 * backdrop blur, both faded out by a `mask-image` so the blur has no hard
 * boundary — a plain `backdrop-blur` would draw a visible seam across the
 * content at the top edge of the footer. It reaches 40px above the footer box to
 * give that fade enough runway to be imperceptible, and down over
 * `--modal-footer-inset` to cover the band the buttons are lifted off, which
 * content also scrolls through. It overscans the viewport edge by 16px so
 * fractional safe-area geometry and browser clipping cannot expose a clear
 * strip at the very bottom.
 *
 * It has to be a pseudo-element rather than the footer itself: a mask on the
 * footer would fade its children, dissolving the tops of the buttons.
 * `before:-z-10` sits it behind those buttons but still above the scrolling
 * content, since the footer's own `z-10` establishes the stacking context.
 *
 * Applied as a descendant selector because the panel owning the scroll
 * container doesn't render the footer — its children do. Every rule is `max-md:`
 * rather than a base rule with a `md:` reset, so desktop (where the footer sits
 * in flow with nothing passing behind it) is left entirely untouched.
 *
 * The scroller must pad its own bottom so body content can clear the pinned
 * actions (see `DetailPanel`: `--touch-height-default` + `--modal-footer-inset`,
 * plus a keyboard-height spacer). The footer is absolutely positioned against
 * the panel frame, which itself ends at the keyboard boundary. It must not be fixed
 * inside the overflow scroller: mobile WebViews can treat that fixed descendant
 * as part of a separate viewport layer and stop handing touch scrolling to the
 * form.
 */
export const floatingFormFooterClass = [
  'max-md:[&_[data-slot=form-footer]]:absolute',
  'max-md:[&_[data-slot=form-footer]]:inset-x-4',
  'max-md:[&_[data-slot=form-footer]]:[bottom:var(--modal-footer-inset)]',
  'max-md:[&_[data-slot=form-footer]]:z-10',
  'max-md:[&_[data-slot=form-footer]]:before:pointer-events-none',
  'max-md:[&_[data-slot=form-footer]]:before:absolute',
  'max-md:[&_[data-slot=form-footer]]:before:inset-x-0',
  'max-md:[&_[data-slot=form-footer]]:before:-top-10',
  'max-md:[&_[data-slot=form-footer]]:before:[bottom:calc(-1*var(--modal-footer-inset)-1rem)]',
  'max-md:[&_[data-slot=form-footer]]:before:-z-10',
  'max-md:[&_[data-slot=form-footer]]:before:bg-gradient-to-t',
  'max-md:[&_[data-slot=form-footer]]:before:from-background',
  'max-md:[&_[data-slot=form-footer]]:before:via-background/80',
  'max-md:[&_[data-slot=form-footer]]:before:to-transparent',
  'max-md:[&_[data-slot=form-footer]]:before:backdrop-blur-[4px]',
  'max-md:[&_[data-slot=form-footer]]:before:[mask-image:linear-gradient(to_top,black_20%,transparent_100%)]',
  'max-md:[&_[data-slot=form-footer]]:before:[-webkit-mask-image:linear-gradient(to_top,black_20%,transparent_100%)]',
].join(' ')
