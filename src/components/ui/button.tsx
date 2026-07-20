/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { type MouseEvent, useCallback, type ComponentProps } from 'react'

import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[length:var(--font-size-body)] font-medium transition-all cursor-pointer disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        // Primary action — brand gradient (same amber→raspberry sweep as the
        // switch ON track). bg-brand is the fallback under the image; hover
        // dims via brightness since the background is an image, not a color.
        default:
          'bg-brand text-brand-foreground shadow-xs [background-image:var(--gradient-brand)] hover:brightness-[1.06] active:brightness-95',
        destructive:
          'bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        // Dark fill uses card (#282a2b) rather than input — input is the dark
        // inset-well tone for form fields; buttons are raised surfaces. The
        // border keeps the default --color-border token in BOTH modes (no
        // dark:border-card override): dialogs/cards paint bg-card, and a
        // card-colored border vanishes there, leaving an unintentional-looking
        // shadow-only edge.
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-card/30 dark:hover:bg-card/50',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-[var(--touch-height-default)] px-4 py-2 has-[>svg]:px-3',
        sm: 'h-[var(--touch-height-sm)] gap-1.5 px-3 has-[>svg]:px-2',
        xs: 'h-7 gap-1 px-2 text-[length:var(--font-size-xs)] has-[>svg]:px-1.5',
        lg: 'h-[var(--touch-height-lg)] px-6 has-[>svg]:px-4',
        icon: 'size-[var(--touch-height-default)]',
        'icon-sm': 'size-[var(--touch-height-sm)]',
        'icon-lg': 'size-[var(--touch-height-lg)]',
        'icon-xs': 'size-7',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

/** Compact 32px muted icon action (panel-header close/X, kebab menus). Pair
 *  with `variant="ghost" size="icon"`. The svg rule bumps icons to 20px unless
 *  the icon carries its own explicit `size-*` class. */
export const mutedIconButtonClass =
  "size-8 rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground [&_svg:not([class*='size-'])]:size-5"

const Button = ({
  className,
  variant,
  size,
  asChild = false,
  onClick,
  ...props
}: ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) => {
  const Comp = asChild ? Slot : 'button'
  const { triggerSelection } = useHaptics()

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      triggerSelection()
      onClick?.(e)
    },
    [onClick, triggerSelection],
  )

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      onClick={handleClick}
      {...props}
    />
  )
}

export { Button, buttonVariants }
