import { useEffect, useRef } from 'react'
import { Input } from '@/components/ui/input'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { User } from 'lucide-react'
import type { OnboardingState } from '@/hooks/use-onboarding-state'
import { useSettings } from '@/hooks/use-settings'

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
}

export const OnboardingNameStep = ({ actions }: OnboardingNameStepProps) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const { preferredName } = useSettings({
    preferred_name: '',
  })

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
      form.setValue('preferredName', preferredName.value)
    }
  }, [preferredName.value, preferredName.isLoading, form])

  useEffect(() => {
    const subscription = form.watch((value) => {
      const hasValidName = !!(value.preferredName && value.preferredName.trim().length > 0)
      actions.setNameValue(value.preferredName || '')
      actions.setNameValid(hasValidName)
    })
    return () => subscription.unsubscribe()
  }, [form, actions])

  return (
    <div className="w-full h-full flex flex-col justify-center">
      <div className="text-center space-y-4">
        <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
          <User className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-2xl font-bold">What should we call you?</h2>
        <p className="text-muted-foreground">Your AI assistant will use this name to address you personally.</p>
      </div>

      <Form {...form}>
        <div className="space-y-6 pt-3">
          <FormField
            control={form.control}
            name="preferredName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Preferred Name</FormLabel>
                <FormControl>
                  <Input placeholder="Enter your name" {...field} ref={inputRef} />
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
