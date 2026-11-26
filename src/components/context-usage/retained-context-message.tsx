/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { CompactionCheckpoint } from '@shared/agent-core'

type RetainedMessage = CompactionCheckpoint['retainedTail'][number]

const roleLabels = {
  user: msg`You`,
  assistant: msg`Assistant`,
  toolResult: msg`Tool result`,
  bashExecution: msg`Command result`,
  custom: msg`Context`,
  branchSummary: msg`Summary`,
  compactionSummary: msg`Summary`,
}

/** Read-only context text; keep image payloads out of the DOM and tool calls inert. */
export const RetainedContextMessage = ({ message }: { message: RetainedMessage }) => {
  const { i18n } = useLingui()
  const content =
    'content' in message
      ? message.content
      : 'summary' in message
        ? message.summary
        : `${message.command}\n${message.output}`
  return (
    <article className="min-w-0 space-y-2 rounded-lg border p-3">
      <h3 className="text-[length:var(--font-size-sm)] font-medium">
        {i18n._(roleLabels[message.role])}
        {message.role === 'toolResult' && <span className="ml-2 text-muted-foreground">{message.toolName}</span>}
      </h3>
      <div className="space-y-2 whitespace-pre-wrap break-words text-[length:var(--font-size-sm)]">
        {typeof content === 'string'
          ? content
          : content.map((part, index) => (
              <div key={index}>
                {part.type === 'text' ? (
                  part.text
                ) : part.type === 'thinking' ? (
                  part.thinking
                ) : part.type === 'image' ? (
                  <span className="text-muted-foreground">
                    <Trans>Image retained</Trans>
                  </span>
                ) : (
                  <>
                    <p className="font-medium">{part.name}</p>
                    <pre className="whitespace-pre-wrap break-all text-xs">
                      {JSON.stringify(part.arguments, null, 2)}
                    </pre>
                  </>
                )}
              </div>
            ))}
      </div>
    </article>
  )
}
