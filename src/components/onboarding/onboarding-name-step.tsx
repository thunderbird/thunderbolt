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
import { OnboardingStepHeader } from './onboarding-step-header'

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

export const OnboardingNameStep = ({ state, actions, onFormDirtyChange }: OnboardingNameStepProps) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isInitialized, setIsInitialized] = useState(false)

  const form = useForm<NameFormData>({
    resolver: zodResolver(nameFormSchema),
    defaultValues: {
      preferredName: '',
    },
    // Prefill from the saved name the connected parent loads into onboarding
    // state (useOnboardingState reads the preferred_name setting) — this
    // component stays presentational with no settings/database dependency.
    // RHF's `values` option syncs the external value in; `keepDirtyValues`
    // ensures an in-progress edit is never clobbered by a late-arriving load.
    values: state.nameValue.trim().length > 0 ? { preferredName: state.nameValue } : undefined,
    resetOptions: { keepDirtyValues: true },
  })

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }, [])

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
    <div className="flex w-full flex-1 flex-col justify-center">
      <OnboardingStepHeader
        icon={<User className="size-10 text-primary" />}
        title="What should we call you?"
        description="Your AI assistant will use this name to address you personally."
      />

      <Form {...form}>
        <div className="mt-10 space-y-6">
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
