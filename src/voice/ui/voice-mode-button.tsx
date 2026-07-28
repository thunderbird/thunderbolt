/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Voice-mode entry button (THU-689). Occupies the composer's send-button slot
 * while the composer is empty (see PromptInput's `emptyStateAction`), so it
 * mirrors the send button's footprint. The session + active-mode UI live in the
 * composer (which morphs into the voice surface), so this is just the trigger.
 */
import { Button } from '@/components/ui/button'
import { AudioLines } from 'lucide-react'

type VoiceModeButtonProps = {
  onStart: () => void
}

export const VoiceModeButton = ({ onStart }: VoiceModeButtonProps) => (
  <Button
    type="button"
    variant="default"
    onClick={onStart}
    aria-label="Start voice mode"
    title="Start voice mode"
    className="size-[var(--touch-height-control)] rounded-[var(--radius-control)] flex items-center justify-center flex-shrink-0"
  >
    <AudioLines className="size-[var(--icon-size-default)]" />
  </Button>
)
