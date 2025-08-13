import React from 'react'
import { Button } from '@/components/ui/button'
import { SectionCard } from '@/components/ui/section-card'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { invoke } from '@tauri-apps/api/core'

const nameFormSchema = z.object({
  preferredName: z.string().optional(),
})

export default function SchedulesSettingsPage() {

  const nameForm = useForm<z.infer<typeof nameFormSchema>>({
    resolver: zodResolver(nameFormSchema),
    defaultValues: {
      preferredName: '',
    },
  })


  async function doTheThing() {
    console.log(`wow. you pressed it! ${new Date().getTime()}`);
    const args = ["dynamic schedule information", "07", "30"];
    try {
      await invoke('run_schedule_installer', { args });
      console.log(`Successfully ran scheduler script`);
    } catch (e) {
      console.log(e);
      console.log(`Probably running outside of Tauri app`);
    }

  }


  return (
    <div className="flex flex-col gap-6 p-4 w-full max-w-[760px] mx-auto">
      <h1 className="mt-8 text-4xl font-bold tracking-tight mb-2 text-primary">Schedules</h1>

      <SectionCard title="Tasks">
        <Form {...nameForm}>
          <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
            <FormField
              control={nameForm.control}
              name="preferredName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Install the Scheduled Task?!</FormLabel>
                  <FormControl>
                    <Button
                      onClick={doTheThing}
                    >
                       Install it. 👏 Install it. 👏 Install it. 👏
                    </Button>
                  </FormControl>
                  <FormDescription>This button installs a scheduled task.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
      </SectionCard>


    </div>
  )
}
