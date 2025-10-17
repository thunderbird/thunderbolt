import { useState, useEffect, useRef } from 'react'
import { Input } from '@/components/ui/input'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { User } from 'lucide-react'
import { useSettings } from '@/hooks/use-settings'
import { OnboardingFooter } from './onboarding-footer'

const nameFormSchema = z.object({
  preferredName: z.string().min(1, { message: 'Name is required.' }),
})

type NameFormData = z.infer<typeof nameFormSchema>

type OnboardingNameStepProps = {
  onNext: () => void
  onSkip: () => void
  onBack: () => void
}

export default function OnboardingNameStep({ onNext, onSkip, onBack }: OnboardingNameStepProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { preferredName } = useSettings({
    preferred_name: '',
  })

  const form = useForm<NameFormData>({
    resolver: zodResolver(nameFormSchema),
    defaultValues: {
      preferredName: preferredName.value || '',
    },
  })

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }, [])

  const onSubmit = async (values: NameFormData) => {
    setIsSubmitting(true)
    await preferredName.setValue(values.preferredName)
    setIsSubmitting(false)
    onNext()
  }

  return (
    <div className="h-full flex flex-col justify-center overflow-x-hidden px-2">
      <div className="text-center space-y-4">
        <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
          <User className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-2xl font-bold">What should we call you?</h2>
        <p className="text-muted-foreground">Your AI assistant will use this name to address you personally.</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 pt-3">
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

          <OnboardingFooter
            onBack={onBack}
            onSkip={onSkip}
            onContinue={form.handleSubmit(onSubmit)}
            continueText={isSubmitting ? 'Saving...' : 'Continue'}
            continueDisabled={isSubmitting}
          />
        </form>
      </Form>
    </div>
  )
}
