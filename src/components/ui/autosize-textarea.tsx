/**
 * This component is from https://shadcnui-expansions.typeart.cc/docs/autosize-textarea
 */

import { cn } from '@/lib/utils'
import {
  useImperativeHandle,
  forwardRef,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type TextareaHTMLAttributes,
  type Ref,
} from 'react'

type UseAutosizeTextAreaProps = {
  textAreaRef: MutableRefObject<HTMLTextAreaElement | null>
  minHeight?: number
  maxHeight?: number
  triggerAutoSize: string
}

export const useAutosizeTextArea = ({
  textAreaRef,
  triggerAutoSize,
  maxHeight = Number.MAX_SAFE_INTEGER,
  minHeight = 0,
}: UseAutosizeTextAreaProps) => {
  useEffect(() => {
    const offsetBorder = 6
    const textAreaElement = textAreaRef.current
    if (textAreaElement) {
      textAreaElement.style.minHeight = `${minHeight + offsetBorder}px`
      textAreaElement.style.maxHeight = maxHeight > minHeight ? `${maxHeight}px` : ''
      textAreaElement.style.height = `${minHeight + offsetBorder}px`
      const scrollHeight = textAreaElement.scrollHeight
      if (scrollHeight > maxHeight) {
        textAreaElement.style.height = `${maxHeight}px`
        textAreaElement.style.overflowY = 'auto'
      } else {
        textAreaElement.style.height = `${scrollHeight + offsetBorder}px`
        textAreaElement.style.overflowY = 'hidden'
      }
    }
  }, [textAreaRef.current, triggerAutoSize, minHeight, maxHeight])
}

export type AutosizeTextAreaRef = {
  textArea: HTMLTextAreaElement
  maxHeight: number
  minHeight: number
}

type AutosizeTextAreaProps = {
  maxHeight?: number
  minHeight?: number
} & TextareaHTMLAttributes<HTMLTextAreaElement>

export const AutosizeTextarea = forwardRef<AutosizeTextAreaRef, AutosizeTextAreaProps>(
  (
    {
      maxHeight = Number.MAX_SAFE_INTEGER,
      minHeight = 52,
      className,
      onChange,
      value,
      ...props
    }: AutosizeTextAreaProps,
    ref: Ref<AutosizeTextAreaRef>,
  ) => {
    const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
    const [triggerAutoSize, setTriggerAutoSize] = useState('')

    useAutosizeTextArea({
      textAreaRef,
      triggerAutoSize: triggerAutoSize,
      maxHeight,
      minHeight,
    })

    useImperativeHandle(ref, () => ({
      textArea: textAreaRef.current as HTMLTextAreaElement,
      focus: () => textAreaRef?.current?.focus(),
      maxHeight,
      minHeight,
    }))

    useEffect(() => {
      setTriggerAutoSize(value as string)
    }, [props?.defaultValue, value])

    return (
      <textarea
        {...props}
        value={value}
        ref={textAreaRef}
        className={cn(
          'flex w-full rounded-md border border-input bg-background px-3 py-2 text-[length:var(--font-size-body)] ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        onChange={(e) => {
          setTriggerAutoSize(e.target.value)
          onChange?.(e)
        }}
      />
    )
  },
)
AutosizeTextarea.displayName = 'AutosizeTextarea'
