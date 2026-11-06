/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NotificationCard } from '@/components/ui/notification-card'
import { AlertTriangle, ChevronDown } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { ResponsivePopover } from '@/components/ui/responsive-popover'
import { useCurrentChatSession } from '@/chats/chat-store'
import { useEffortSelectorState } from './use-effort-selector-state'
import { needsApiKey } from '@/settings/models/model-policy'
import { GradientLock } from '@/components/ui/gradient-lock'
import { AttestationMenuRow, AttestationModal, useChatAttestationState } from '@/components/chat/attestation'
import { useEffortSelectorMenu } from './use-effort-selector-menu'
import { EffortControls } from './effort-controls'
import { EffortRing } from './effort-ring'
import './effort-selector.css'

export const EffortSelector = ({ modelPicker }: { modelPicker?: (onClose: () => void) => ReactNode }) => {
  const { t } = useLingui()
  const { selectedModel, chatThread } = useCurrentChatSession()
  const effort = useEffortSelectorState()
  const attestation = useChatAttestationState()
  const { choices, value, kind, error, dismissError } = effort
  const { open, setOpen, privacyOpen, setPrivacyOpen, triggerRef } = useEffortSelectorMenu(attestation.target?.key)
  if (!choices.length && !modelPicker) {
    return null
  }
  const current = choices.findIndex((choice) => choice.value === value)
  const effortName = choices[current]?.name ?? t`Choose effort`
  const effortDescription = t`Reasoning effort: ${effortName}`
  const modelName = selectedModel.name
  const accessibleDescription = modelPicker
    ? choices.length
      ? t`Model: ${modelName}. Reasoning effort: ${effortName}`
      : t`Model: ${modelName}`
    : effortDescription
  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      data-testid={modelPicker ? 'model-selector-trigger' : undefined}
      aria-haspopup="dialog"
      // With the model picker the visible model name is the accessible name, so voice control can say it.
      aria-label={modelPicker ? undefined : t`Reasoning effort`}
      title={choices.length ? effortDescription : selectedModel.name}
      aria-description={accessibleDescription}
      className="flex shrink-0 cursor-pointer items-center gap-1.5 px-2 h-[var(--touch-height-control)] rounded-[var(--radius-control)] text-[length:var(--font-size-sm)] font-medium text-muted-foreground transition-colors hover:bg-accent/50 data-[state=open]:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50"
    >
      {modelPicker &&
        (needsApiKey(selectedModel) ? (
          <AlertTriangle aria-label={t`API key not configured`} className="size-3.5 shrink-0 text-warning" />
        ) : selectedModel.isConfidential === 1 ? (
          <GradientLock className="size-3.5 shrink-0" />
        ) : null)}
      {modelPicker && <span className="max-w-40 truncate">{selectedModel.name}</span>}
      {current >= 0 && <EffortRing value={value} values={choices.map((choice) => choice.value)} kind={kind} />}
      <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
    </button>
  )
  return (
    <>
      <ResponsivePopover
        open={open}
        onOpenChange={setOpen}
        trigger={trigger}
        title={modelPicker ? t`Model and reasoning effort` : t`Reasoning effort`}
        mobileMenu={{ side: 'bottom', showTitle: !modelPicker }}
        desktopMenu={{
          side: !chatThread ? 'bottom' : 'top',
          align: 'end',
          sideOffset: 5,
          className:
            'flex max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0',
        }}
      >
        {modelPicker?.(() => setOpen(false))}
        {modelPicker && attestation.target && (
          <AttestationMenuRow
            target={attestation.target}
            state={attestation.state}
            onClick={() => setPrivacyOpen(true)}
          />
        )}
        {choices.length > 0 && <EffortControls key={selectedModel.id} {...effort} />}
      </ResponsivePopover>
      {modelPicker && attestation.target && (
        <AttestationModal
          target={attestation.target}
          state={attestation.state}
          onVerify={attestation.verify}
          hour12={attestation.hour12}
          open={privacyOpen}
          onOpenChange={setPrivacyOpen}
          returnFocusRef={triggerRef}
        />
      )}
      {createPortal(
        <>
          {!open && error && (
            <span role="alert" className="sr-only">
              {error}
            </span>
          )}
          <NotificationCard
            open={!open && error !== null}
            icon={<AlertTriangle aria-hidden="true" className="size-[var(--icon-size-default)] text-destructive" />}
            message={error ?? ''}
            onDismiss={dismissError}
          />
        </>,
        document.body,
      )}
    </>
  )
}
