/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { type MouseEvent, useCallback, type ComponentProps } from 'react'

import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[length:var(--font-size-body)] font-medium transition-all cursor-pointer disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        // Primary action — amber→raspberry brand gradient. bg-brand is the
        // fallback under the image; hover
        // dims via brightness since the background is an image, not a color.
        // The transparent border preserves the same box geometry as outlined
        // secondary actions without drawing a grey edge over the gradient.
        //
        // `bg-origin-border` is load-bearing next to that transparent border, and
        // matches checkbox/switch, which pair the same two. Backgrounds are
        // *clipped* to the border box but *originate* at the padding box, so the
        // gradient is laid out 2px narrower than it is painted and the default
        // `repeat` fills the leftover 1px strips with the neighbouring tile's
        // edge: the gradient's end colour down the left, its start colour down
        // the right. On this amber→raspberry sweep that reads as a bright pink
        // hairline on one side and a drab one on the other (THU-857).
        default:
          'border border-transparent bg-brand bg-origin-border text-brand-foreground shadow-xs [background-image:var(--gradient-brand)] hover:brightness-[1.06] active:brightness-95 disabled:bg-secondary disabled:text-muted-foreground disabled:shadow-none disabled:opacity-100 disabled:brightness-100 disabled:[background-image:none]',
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
      loading: {
        true: '',
        false: '',
      },
    },
    compoundVariants: [
      // A loading primary button keeps its brand gradient (dimmed) instead of
      // the flat disabled treatment — it is busy, not unavailable. Non-primary
      // variants intentionally have no loading override and fall back to their
      // regular disabled treatment (pinned by button.test.tsx).
      {
        variant: 'default',
        loading: true,
        class:
          'disabled:bg-brand disabled:text-brand-foreground/80 disabled:brightness-75 disabled:saturate-50 disabled:[background-image:var(--gradient-brand)]',
      },
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default',
      loading: false,
    },
  },
)

/** Muted icon action for panel headers and menus. Pair with
 *  `variant="ghost" size="icon"`. Mobile matches the 48px height of the
 *  floating New Chat / page-create pills; desktop remains the compact 32px
 *  size. Icons default to --icon-size-default (20px / 16px); icons carrying
 *  their own explicit `size-*` class keep their own size. Mobile is a circle like the
 *  responsive modal's close control; desktop's rounded-xl matches the sidebar
 *  nav toggle. */
export const mutedIconButtonClass =
  "size-[var(--touch-height-lg)] md:size-[var(--touch-height-sm)] rounded-full md:rounded-xl text-muted-foreground hover:bg-muted dark:hover:bg-muted hover:text-foreground active:bg-muted data-[state=open]:bg-muted data-[state=open]:text-foreground [&_svg:not([class*='size-'])]:size-[var(--icon-size-default)]"

type ButtonProps = ComponentProps<'button'> &
  // `loading` is derived from `isLoading` — not an independent prop.
  Omit<VariantProps<typeof buttonVariants>, 'loading'> & {
    asChild?: boolean
    isLoading?: boolean
    loadingLabel?: string
  }

const Button = ({
  className,
  variant,
  size,
  asChild = false,
  isLoading = false,
  loadingLabel,
  disabled,
  children,
  onClick,
  ...props
}: ButtonProps) => {
  const Comp = asChild ? Slot : 'button'
  const { triggerSelection } = useHaptics()
  const isDisabled = disabled || isLoading

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      // Slot can render an anchor, where the native `disabled` attribute has
      // no effect. Cancel activation here before haptics or caller logic.
      if (isDisabled) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      triggerSelection()
      onClick?.(e)
    },
    [isDisabled, onClick, triggerSelection],
  )

  return (
    <Comp
      {...props}
      data-slot="button"
      className={cn(buttonVariants({ variant, size, loading: isLoading, className }))}
      onClick={handleClick}
      disabled={asChild ? undefined : isDisabled}
      aria-disabled={asChild && isDisabled ? true : undefined}
      aria-busy={isLoading || undefined}
      tabIndex={asChild && isDisabled ? -1 : props.tabIndex}
    >
      {/* Slot requires exactly one element child, so the loader can only be
          injected when rendering a real <button>. asChild callers keep their
          single child untouched (they don't use isLoading today). */}
      {asChild ? (
        children
      ) : (
        <>
          {isLoading && <Loader2 className="animate-spin" />}
          {isLoading && loadingLabel ? loadingLabel : children}
        </>
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
