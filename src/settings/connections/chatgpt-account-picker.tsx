/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, Plus } from 'lucide-react'
import { useDatabase } from '@/contexts'
import { ProviderConnectionButton } from '@/components/provider-connection-button'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { listChatGPTAccounts } from '@/providers/chatgpt-registration'

/** Chooses a local account registration; OAuth must finish before it becomes active. */
export const ChatGPTAccountPicker = ({
  onChoose,
  onCancel,
  isPending,
  disabled = false,
}: {
  onChoose: (clientId: string | null) => void
  onCancel: () => void
  isPending: boolean
  disabled?: boolean
}) => {
  const { t } = useLingui()
  const db = useDatabase()
  const { data: accounts = [] } = useQuery({
    queryKey: ['chatgpt-accounts'],
    queryFn: () => listChatGPTAccounts(db),
  })
  const active = accounts.find((account) => account.active)
  if (isPending) {
    return (
      <ProviderConnectionButton
        isConnected={false}
        isProcessing
        connectLabel={t`Choose ChatGPT account`}
        onCancel={onCancel}
        onConnect={() => {}}
      />
    )
  }
  if (accounts.length === 0) {
    return null
  }
  return (
    <div className="flex max-w-full flex-col items-center gap-1">
      {active && (
        <p className="max-w-full truncate text-xs text-muted-foreground" title={active.label}>
          {active.label}
        </p>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="text-xs font-normal text-muted-foreground"
            disabled={disabled}
          >
            <Trans>Choose ChatGPT account</Trans>
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          {accounts.map((account) => (
            <DropdownMenuItem key={account.clientId} onSelect={() => onChoose(account.clientId)}>
              <span className="max-w-72 truncate" title={account.label}>
                {account.label}
              </span>
              {account.active && <Check className="ml-auto size-4" aria-label={t`Active account`} />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onChoose(null)}>
            <Plus />
            <Trans>Use another ChatGPT account</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
