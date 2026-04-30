/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type VariantProps } from 'class-variance-authority'
import { type ComponentProps, createContext, useContext } from 'react'

import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const ButtonGroupContext = createContext<VariantProps<typeof buttonVariants>>({
  size: 'default',
  variant: 'default',
})

/**
 * A group of buttons that are visually connected together
 *
 * @example
 * ```tsx
 * <ButtonGroup variant="outline" size="sm">
 *   <ButtonGroupItem onClick={() => console.log('First')}>
 *     First
 *   </ButtonGroupItem>
 *   <ButtonGroupItem onClick={() => console.log('Second')}>
 *     Second
 *   </ButtonGroupItem>
 *   <ButtonGroupItem onClick={() => console.log('Third')}>
 *     Third
 *   </ButtonGroupItem>
 * </ButtonGroup>
 * ```
 */
const ButtonGroup = ({
  className,
  variant,
  size,
  children,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof buttonVariants>) => {
  return (
    <div
      data-slot="button-group"
      data-variant={variant}
      data-size={size}
      className={cn(
        'group/button-group flex w-fit items-center rounded-lg data-[variant=outline]:shadow-xs',
        className,
      )}
      {...props}
    >
      <ButtonGroupContext.Provider value={{ variant, size }}>{children}</ButtonGroupContext.Provider>
    </div>
  )
}

/**
 * Individual button item within a ButtonGroup
 * Can override the group's variant and size if needed
 */
const ButtonGroupItem = ({
  className,
  children,
  variant,
  size,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) => {
  const context = useContext(ButtonGroupContext)

  return (
    <button
      data-slot="button-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      className={cn(
        buttonVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        'min-w-0 flex-1 shrink-0 rounded-none shadow-none first:rounded-l-lg last:rounded-r-lg focus:z-10 focus-visible:z-10 data-[variant=outline]:border-l-0 data-[variant=outline]:first:border-l',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

export { ButtonGroup, ButtonGroupItem }
