/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { GradientCircleCheck } from '@/components/ui/gradient-circle-check'
import { StatusCard } from '@/components/ui/status-card'
import { cn } from '@/lib/utils'
import { Trans, useLingui } from '@lingui/react/macro'
import { Info, ShieldAlert, WifiOff } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useRecoveryContinuity, type RecoveryContinuityContextValue } from './recovery-continuity-provider'

const cardId = 'recovery-phrase-status'

const Fact = ({ label, value, attention }: { label: ReactNode; value: ReactNode; attention: boolean }) => (
  <div className="flex items-center justify-between gap-4 py-2">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="flex items-center gap-2 text-right font-medium">
      <span aria-hidden className={cn('size-2 rounded-full', attention ? 'bg-warning' : 'bg-muted-foreground/40')} />
      {value}
    </dd>
  </div>
)

type Header = { icon: ReactNode; title: string; description: string }

/** The card's headline: this device's trust first, then the phrase, then a phrase notice, then the passkey. */
const useHeader = ({ status, notice, passkey }: RecoveryContinuityContextValue): Header | null => {
  const { t } = useLingui()
  const warningIcon = <ShieldAlert className="size-5 text-warning" aria-hidden />
  if (status === 'unverified') {
    return {
      icon: warningIcon,
      title: t`This device couldn't be verified`,
      description: t`Thunderbolt couldn't verify this device's encryption keys, so it can't update your recovery phrase or passkey. To verify it, sign out with "Delete data from device", sign in again, and approve it from a device that was trusted before.`,
    }
  }
  if (status === 'untrusted') {
    return {
      icon: warningIcon,
      title: t`Recovery phrase needs an update`,
      description: t`Your phrase was created before a security update. This device isn't approved yet, so it can't create a new one. Open Thunderbolt on an approved device and update it there.`,
    }
  }
  if (status === 'warning' || status === 'offline') {
    return {
      icon: warningIcon,
      title: t`Recovery phrase needs an update`,
      description: t`Your phrase was created before a security update. Replace it so recovery can confirm your encryption keys are yours. Your current phrase keeps working until you do.`,
    }
  }
  if (notice === 'updatedHere') {
    return {
      icon: <GradientCircleCheck className="size-5" />,
      title: t`Recovery phrase updated`,
      description: t`Your new phrase is the only one that works now. Keep it somewhere safe.`,
    }
  }
  if (notice === 'updatedElsewhere') {
    return {
      icon: <Info className="size-5 text-muted-foreground" aria-hidden />,
      title: t`Updated on another device`,
      description: t`Your recovery phrase was replaced on another of your devices. Use the new phrase you saved there; the old one no longer works. If this wasn't you, review your devices.`,
    }
  }
  if (passkey === 'needsUpdate' || passkey === 'blocked') {
    return {
      icon: warningIcon,
      title: t`Passkey needs an update`,
      description: t`Your passkey was added before a security update. Check it once so unlocking with it can confirm your encryption keys are yours.`,
    }
  }
  if (notice === 'passkeyUpdated') {
    return {
      icon: <GradientCircleCheck className="size-5" />,
      title: t`Passkey updated`,
      description: t`Unlocking with this passkey now confirms your encryption keys.`,
    }
  }
  return null
}

/**
 * The status card at the top of Preferences: encryption, this device's trust,
 * the recovery phrase and, when there is a slot, the passkey, each as a fact,
 * with the action this device may take. It cannot be dismissed while something
 * needs attention; "Got it" clears only a notice.
 */
export const RecoveryContinuityStatusCard = () => {
  const continuity = useRecoveryContinuity()
  const header = useHeader(continuity)
  return header ? <ShownStatusCard continuity={continuity} header={header} /> : null
}

const ShownStatusCard = ({ continuity, header }: { continuity: RecoveryContinuityContextValue; header: Header }) => {
  const navigate = useNavigate()
  const { hash } = useLocation()
  const { status, phraseUpdateRequired, passkey, notice, deviceTrusted, passkeyMigration } = continuity
  const titleRef = useRef<HTMLSpanElement>(null)

  // Legitimate useEffect: scroll and focus (DOM) for the Settings marker's deep link.
  useEffect(() => {
    if (hash !== `#${cardId}`) {
      return
    }
    titleRef.current?.scrollIntoView?.({ block: 'start' })
    titleRef.current?.focus()
  }, [hash])

  const goToDevices = () => navigate('/settings/devices')
  const phraseActionable = status === 'warning' || status === 'offline'
  const passkeyFact = passkey === 'none' ? null : passkey

  return (
    <StatusCard
      id={cardId}
      icon={header.icon}
      title={
        <span ref={titleRef} tabIndex={-1} className="scroll-mt-[var(--header-inset)] outline-hidden">
          {header.title}
        </span>
      }
      description={<span role="status">{header.description}</span>}
    >
      <dl className="mt-3 divide-y divide-border border-y border-border text-sm">
        <Fact label={<Trans>Encryption</Trans>} value={<Trans>On</Trans>} attention={false} />
        <Fact
          label={<Trans>This device</Trans>}
          value={
            status === 'unverified' ? (
              <Trans>Unverified</Trans>
            ) : deviceTrusted ? (
              <Trans>Approved</Trans>
            ) : (
              <Trans>Not approved yet</Trans>
            )
          }
          attention={!deviceTrusted}
        />
        <Fact
          label={<Trans>Recovery phrase</Trans>}
          value={phraseUpdateRequired ? <Trans>Needs update</Trans> : <Trans>Up to date</Trans>}
          attention={phraseUpdateRequired}
        />
        {passkeyFact && (
          <Fact
            label={<Trans>Passkey</Trans>}
            value={passkeyFact === 'protected' ? <Trans>Protected</Trans> : <Trans>Needs update</Trans>}
            attention={passkeyFact !== 'protected'}
          />
        )}
      </dl>
      {status === 'offline' && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <WifiOff className="size-4 shrink-0" aria-hidden />
          <Trans>You're offline. You can update it once you reconnect.</Trans>
        </p>
      )}
      {passkeyMigration.errorMessage && (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {passkeyMigration.errorMessage}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {phraseActionable && (
          <Button disabled={status === 'offline'} onClick={() => void continuity.start()}>
            <Trans>Update recovery phrase</Trans>
          </Button>
        )}
        {passkey === 'needsUpdate' && (
          <Button
            variant={phraseActionable ? 'secondary' : 'default'}
            disabled={passkeyMigration.busy}
            onClick={() => void continuity.startPasskeyMigration()}
          >
            <Trans>Update passkey</Trans>
          </Button>
        )}
        {(status === 'untrusted' || status === 'unverified') && (
          <Button variant="outline" onClick={goToDevices}>
            <Trans>View devices</Trans>
          </Button>
        )}
        {notice === 'updatedElsewhere' && (
          <Button variant="outline" onClick={goToDevices}>
            <Trans>Review devices</Trans>
          </Button>
        )}
        {notice !== 'none' && (
          <Button variant="secondary" onClick={continuity.dismissNotice}>
            <Trans>Got it</Trans>
          </Button>
        )}
      </div>
    </StatusCard>
  )
}
