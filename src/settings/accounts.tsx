import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { accountsTable } from '@/db/tables'
import { DatabaseSingleton } from '@/db/singleton'
import ImapClient from '@/imap/imap'
import { getAllAccounts } from '@/lib/dal'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eq } from 'drizzle-orm'
import { Plus } from 'lucide-react'
import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

const formSchema = z.object({
  hostname: z.string().min(1, { message: 'Hostname is required.' }),
  port: z.number().int().min(1, { message: 'Port is required.' }),
  username: z.string().min(1, { message: 'Username is required.' }),
  password: z.string().min(1, { message: 'Password is required.' }),
})

type FormData = z.infer<typeof formSchema>

export default function AccountsSettingsPage() {
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()
  const [showDialog, setShowDialog] = useState(false)
  const [showSaved, setShowSaved] = useState(false)

  // Add state for the selected account
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null)

  // Fetch accounts from the database
  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: getAllAccounts,
  })

  // Select first account by default
  useEffect(() => {
    if (accounts.length > 0 && !selectedAccount) {
      setSelectedAccount(accounts[0].id)
    }
  }, [accounts, selectedAccount])

  // Find the currently selected account
  const currentAccount = accounts.find((account) => account.id === selectedAccount)

  // Update account mutation
  const updateAccountMutation = useMutation({
    mutationFn: async (values: FormData) => {
      if (!selectedAccount) return

      await db
        .update(accountsTable)
        .set({
          imapHostname: values.hostname,
          imapPort: values.port,
          imapUsername: values.username,
          imapPassword: values.password,
        })
        .where(eq(accountsTable.id, selectedAccount))
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] })
      setShowSaved(true)
      setTimeout(() => setShowSaved(false), 2000)
    },
  })

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      hostname: currentAccount?.imapHostname || '',
      port: currentAccount?.imapPort || 993,
      username: currentAccount?.imapUsername || '',
      password: currentAccount?.imapPassword || '',
    },
  })

  // Update form when selected account changes
  useEffect(() => {
    if (currentAccount) {
      form.reset({
        hostname: currentAccount.imapHostname || '',
        port: currentAccount.imapPort || 993,
        username: currentAccount.imapUsername || '',
        password: currentAccount.imapPassword || '',
      })
    }
  }, [currentAccount, form])

  const onSubmit = async (values: FormData) => {
    setShowSaved(false)
    await updateAccountMutation.mutateAsync(values)

    // @todo eventually, either ImapClient should be a singleton that is managed by a context provider OR we should just make all imap operations be purely functional.
    const imap = new ImapClient()
    await imap.initialize({
      hostname: values.hostname,
      port: values.port,
      username: values.username,
      password: values.password,
    })
  }

  return (
    <>
      <div className="flex flex-col gap-4 p-4 w-full max-w-[760px] mx-auto">
        <div className="flex items-center justify-between">
          <h1 className="mt-8 text-4xl font-bold tracking-tight mb-2 text-primary">Accounts</h1>
          <Button variant="outline" size="icon" onClick={() => setShowDialog(true)}>
            <Plus />
          </Button>
        </div>

        <ResponsiveModal open={showDialog} onOpenChange={setShowDialog}>
          <ResponsiveModalContent>
            <ResponsiveModalTitle>Multiple Accounts</ResponsiveModalTitle>
            <ResponsiveModalDescription>Support for multiple accounts is coming soon!</ResponsiveModalDescription>
          </ResponsiveModalContent>
        </ResponsiveModal>

        {accounts.length > 0 && (
          <Select value={selectedAccount || undefined} onValueChange={setSelectedAccount}>
            <SelectTrigger className="w-full p-6 py-8">
              <div className="flex items-center gap-4">
                <div className="flex items-center justify-center bg-primary text-primary-foreground size-8 rounded-md font-medium">
                  {currentAccount?.imapUsername?.[0]?.toUpperCase() || '?'}
                </div>
                <div className="flex flex-col">
                  <SelectValue placeholder="Select an account" />
                  <div className="text-sm text-muted-foreground">{currentAccount?.imapUsername}</div>
                </div>
              </div>
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  <p className="text-left">{account.imapUsername}</p>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <h2 className="text-xl font-bold">IMAP</h2>
        <Card>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
                <FormField
                  control={form.control}
                  name="hostname"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Hostname</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="port"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Port</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          onChange={(e) => field.onChange(parseInt(e.target.value) || 993)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Username</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <Input type="password" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  type="submit"
                  disabled={updateAccountMutation.isPending || !form.formState.isDirty}
                  onClick={() => {
                    if (form.formState.isDirty) {
                      setShowSaved(false)
                    }
                  }}
                >
                  {updateAccountMutation.isPending ? 'Saving...' : showSaved ? 'Saved!' : 'Save'}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
