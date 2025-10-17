import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { User } from 'lucide-react'
import { useSettings } from '@/hooks/use-settings'

const nameFormSchema = z.object({
  preferredName: z.string().min(1, { message: 'Name is required.' }),
})

type NameFormData = z.infer<typeof nameFormSchema>

type OnboardingStep3Props = {
  onNext: () => void
  onSkip: () => void
  onBack: () => void
}

export default function OnboardingStep3({ onNext, onSkip, onBack }: OnboardingStep3Props) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const { preferredName } = useSettings({
    preferred_name: '',
  })

  const form = useForm<NameFormData>({
    resolver: zodResolver(nameFormSchema),
    defaultValues: {
      preferredName: preferredName.value || '',
    },
  })

  const onSubmit = async (values: NameFormData) => {
    setIsSubmitting(true)
    await preferredName.setValue(values.preferredName)
    setIsSubmitting(false)
    onNext()
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-4">
        <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
          <User className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-2xl font-bold">What should we call you?</h2>
        <p className="text-muted-foreground">Your AI assistant will use this name to address you personally.</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <FormField
            control={form.control}
            name="preferredName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Preferred Name</FormLabel>
                <FormControl>
                  <Input placeholder="Enter your name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="space-y-3 pt-4">
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Continue'}
            </Button>
            <Button onClick={onSkip} variant="outline" className="w-full" disabled={isSubmitting}>
              Skip for Now
            </Button>
            <Button onClick={onBack} variant="ghost" className="w-full" disabled={isSubmitting}>
              Back
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
