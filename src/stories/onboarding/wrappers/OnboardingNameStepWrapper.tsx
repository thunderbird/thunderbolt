import { useState, useEffect, useRef } from 'react'
import { Input } from '@/components/ui/input'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { User } from 'lucide-react'
import { Button } from '@/components/ui/button'

const nameFormSchema = z.object({
  preferredName: z.string().min(1, { message: 'Name is required.' }),
})

type NameFormData = z.infer<typeof nameFormSchema>

type OnboardingNameStepWrapperProps = {
  onNext: () => void
}

export const OnboardingNameStepWrapper = ({ onNext }: OnboardingNameStepWrapperProps) => {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

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

  const onSubmit = async () => {
    setIsSubmitting(true)
    // Simulate saving
    await new Promise((resolve) => setTimeout(resolve, 500))
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

          <div className="pt-5">
            <Button onClick={form.handleSubmit(onSubmit)} disabled={isSubmitting} className="w-full">
              {isSubmitting ? 'Saving...' : 'Continue'}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
