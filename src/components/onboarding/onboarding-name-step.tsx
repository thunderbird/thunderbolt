/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { User } from 'lucide-react'
import type { OnboardingState } from '@/hooks/use-onboarding-state'
import { useSettings } from '@/hooks/use-settings'
import { IconCircle } from './icon-circle'

const nameFormSchema = z.object({
  preferredName: z.string().min(1, { message: 'Name is required.' }),
})

type NameFormData = z.infer<typeof nameFormSchema>

type OnboardingNameStepProps = {
  state: OnboardingState
  actions: {
    setNameValue: (value: string) => void
    setNameValid: (valid: boolean) => void
    setSubmittingName: (submitting: boolean) => void
    submitName: (name: string) => Promise<void>
    nextStep: () => Promise<void>
    prevStep: () => Promise<void>
    skipStep: () => Promise<void>
  }
  onFormDirtyChange?: (isDirty: boolean) => void
}

export const OnboardingNameStep = ({ actions, onFormDirtyChange }: OnboardingNameStepProps) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const { preferredName } = useSettings({
    preferred_name: '',
  })
  const [isInitialized, setIsInitialized] = useState(false)

  const form = useForm<NameFormData>({
    resolver: zodResolver(nameFormSchema),
    defaultValues: {
      preferredName: '',
    },
  })

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }, [])

  useEffect(() => {
    if (preferredName.value && !preferredName.isLoading && preferredName.value.trim().length > 0) {
      form.setValue('preferredName', preferredName.value, { shouldDirty: false }) // Don't mark as dirty when loading saved value
    }
  }, [preferredName.value, preferredName.isLoading, form])

  useEffect(() => {
    if (!isInitialized) {
      return
    } // Don't track changes until initialized

    const subscription = form.watch((value) => {
      const hasValidName = !!(value.preferredName && value.preferredName.trim().length > 0)
      actions.setNameValue(value.preferredName || '')
      actions.setNameValid(hasValidName)
      onFormDirtyChange?.(form.formState.isDirty)
    })
    return () => subscription.unsubscribe()
  }, [form, actions, isInitialized, onFormDirtyChange])

  useEffect(() => {
    form.reset(form.getValues())

    const currentValue = form.getValues().preferredName
    const hasValidName = !!(currentValue && currentValue.trim().length > 0)
    actions.setNameValue(currentValue || '')
    actions.setNameValid(hasValidName)

    setIsInitialized(true)
    onFormDirtyChange?.(false)
  }, [])

  return (
    <div className="w-full h-full flex flex-col justify-center">
      <div className="text-center space-y-4">
        <IconCircle>
          <User className="w-8 h-8 text-primary" />
        </IconCircle>
        <h2 className="text-2xl font-bold">What should we call you?</h2>
        <p className="text-muted-foreground">Your AI assistant will use this name to address you personally.</p>
      </div>

      <Form {...form}>
        <div className="space-y-6 pt-5">
          <FormField
            control={form.control}
            name="preferredName"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input placeholder="Enter your name" {...field} ref={inputRef} autoComplete="off" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </Form>
    </div>
  )
}
