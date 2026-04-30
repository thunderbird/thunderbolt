/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReasoningUIPart } from 'ai'
import { Check, Loader2 } from 'lucide-react'
import { Expandable } from '../ui/expandable'

type ReasoningPartProps = {
  part: ReasoningUIPart
}

export const ReasoningPart = ({ part }: ReasoningPartProps) => {
  const state = part.state

  return (
    <Expandable
      title={<span className="text-muted-foreground">Thinking</span>}
      className="shadow-none"
      icon={
        state === 'streaming' ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" data-testid="reasoning-loading" />
        ) : (
          <Check className="h-4 w-4 text-muted-foreground" data-testid="reasoning-completed" />
        )
      }
      defaultOpen={false}
    >
      <div className="text-muted-foreground leading-relaxed text-sm">{part.text}</div>
    </Expandable>
  )
}
