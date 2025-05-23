import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useDrizzle } from '@/db/provider'
import { accountsTable } from '@/db/tables'
import ImapClient from '@/imap/imap'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eq } from 'drizzle-orm'
import { Plus } from 'lucide-react'
import React from 'react'
import { useForm } from 'react-hook-form'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

const formSchema = z.object({
  hostname: z.string().min(1, { message: 'Hostname is required.' }),
  port: z.coerce.number().int().min(1, { message: 'Port is required.' }),
  username: z.string().min(1, { message: 'Username is required.' }),
  password: z.string().min(1, { message: 'Password is required.' }),
})

export default function AccountsSettingsPage() {
  const { db } = useDrizzle()
  const queryClient = useQueryClient()
  const [showDialog, setShowDialog] = React.useState(false)
  const [showSaved, setShowSaved] = React.useState(false)

  // Add state for the selected account
  const [selectedAccount, setSelectedAccount] = React.useState<string | null>(null)

  // Fetch accounts from the database
  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => {
      return await db.select().from(accountsTable)
    },
  })

  // Create account mutation
  const createAccountMutation = useMutation({
    mutationFn: async () => {
      const id = uuidv7()
      await db.insert(accountsTable).values({
        id,
        type: 'imap',
        imapHostname: '',
        imapPort: 993,
        imapUsername: '',
        imapPassword: '',
      })
      return id
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] })
      setSelectedAccount(id)
    },
  })

  // Select first account by default
  React.useEffect(() => {
    if (accounts.length > 0 && !selectedAccount) {
      setSelectedAccount(accounts[0].id)
    }
  }, [accounts, selectedAccount])

  // Find the currently selected account
  const currentAccount = accounts.find((account) => account.id === selectedAccount)

  // Update account mutation
  const updateAccountMutation = useMutation({
    mutationFn: async (values: z.infer<typeof formSchema>) => {
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

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      hostname: currentAccount?.imapHostname || '',
      port: currentAccount?.imapPort || 993,
      username: currentAccount?.imapUsername || '',
      password: currentAccount?.imapPassword || '',
    },
  })

  // Update form when selected account changes
  React.useEffect(() => {
    if (currentAccount) {
      form.reset({
        hostname: currentAccount.imapHostname || '',
        port: currentAccount.imapPort || 993,
        username: currentAccount.imapUsername || '',
        password: currentAccount.imapPassword || '',
      })
    }
  }, [currentAccount, form])

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
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
          <h1 className="text-4xl font-bold tracking-tight mb-2 text-primary">Accounts</h1>
          <Button variant="outline" size="icon" onClick={() => setShowDialog(true)}>
            <Plus />
          </Button>
        </div>

        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent>
            <DialogTitle>Multiple Accounts</DialogTitle>
            <DialogDescription>Support for multiple accounts is coming soon!</DialogDescription>
          </DialogContent>
        </Dialog>

        {accounts.length > 0 && (
          <Select value={selectedAccount || undefined} onValueChange={setSelectedAccount}>
            <SelectTrigger className="w-full p-6 py-8" variant="outline">
              <div className="flex items-center gap-4">
                <div className="flex items-center justify-center bg-primary text-primary-foreground size-8 rounded-md font-medium">{currentAccount?.imapUsername?.[0]?.toUpperCase() || '?'}</div>
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
                        <Input type="number" {...field} />
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
