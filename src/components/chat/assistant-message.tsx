/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AcpCompactionNotice } from '@/components/context-usage'
import { isRenderHtmlPart } from '@/artifacts/render-html-tool'
import {
  artifactRendersStandalone,
  filterMessageParts,
  type GroupedUIPart,
  groupMessageParts,
  type ReasoningGroupUIPart,
  type ToolOrDynamicToolUIPart,
} from '@/lib/assistant-message'
import { extractTextFromParts } from '@/lib/message-utils'
import { splitPartType } from '@/lib/utils'
import type { HaystackReferenceMeta, ThunderboltUIMessage, UIMessageMetadata } from '@/types'
import type { SourceMetadata } from '@/types/source'
import type { TextUIPart } from 'ai'
import { Trans } from '@lingui/react/macro'
import { memo, useMemo, type ReactNode } from 'react'
import { ArtifactMessagePart } from './artifact-message-part'
import { CopyMessageButton } from './copy-message-button'
import { CreatedFileVersionGroup } from './created-file-version-group'
import { ReasoningGroup } from './reasoning-group'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { TextPart } from './text-part'
import { responseHeadingId } from './latest-response'

type AssistantMessageProps = {
  message: ThunderboltUIMessage
  /** Sources this message's `[N]` citations may refer to — its own plus earlier turns'
   *  (see `useThreadSources`). Defaults to the message's own `metadata.sources`. */
  sources?: SourceMetadata[]
  isStreaming: boolean
  /** Hide the created-file cards until the turn ends, so a file the model may still replace never shows. */
  holdFiles?: boolean
  isLastMessage?: boolean
  isLastAssistantMessage?: boolean
  lastAssistantAction?: ReactNode
  activity?: ReactNode
}

// While an answer streams, reserve enough room to keep the preceding user
// message pinned near the top. Settled answers return to their natural height
// so short threads do not retain artificial overflow.
const lastMessageMinHeight = '72dvh'

// Stable empty default so a message without reasoning timings keeps a constant
// reference across renders (a fresh `{}` each render would defeat memoization).
const emptyReasoningTime: Record<string, number> = {}

// Animation classes for subtle slide-in effect
const animationClasses = 'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out'

/** `tool-<name>` and `dynamic-tool` parts are both tool calls; anything else is the type's first segment. */
const partKind = (part: GroupedUIPart): string => (part.type === 'dynamic-tool' ? 'tool' : splitPartType(part.type)[0])

/**
 * Converts grouped message parts into React elements for rendering.
 * Handles different part types (reasoning, tools, text) and manages loading states.
 * @internal - Exported for testing only
 */
export const mountMessageParts = (
  groupedParts: GroupedUIPart[],
  isStreaming: boolean,
  messageId: string,
  reasoningTime: Record<string, number>,
  reasoningStartTimes?: Record<string, number>,
  sources?: SourceMetadata[],
  haystackReferences?: HaystackReferenceMeta[],
  mcpTools?: UIMessageMetadata['mcpTools'],
) => {
  const partElements: ReactNode[] = []
  // File chips are not counted, so holding them back never moves another part's animation class.
  let appended = 0

  const appendPart = (element: ReactNode, key: number) => {
    const index = appended++
    // The second part replaces the loading indicator in place.
    partElements.push(
      <div key={key} className={index === 1 ? '' : animationClasses}>
        {element}
      </div>,
    )
  }

  if (groupedParts.length === 0 && isStreaming) {
    // isStreaming should always be true because the next part will *replace* this one
    appendPart(<SyntheticLoadingPart isStreaming />, 0)
  }

  // Whether the message has a "body" that serves as the answer — a text part, or a
  // lifted-out artifact (a standalone `tool` part). When it does, the reasoning group
  // suppresses its ephemeral reasoning display (and that display's 200px reserve),
  // which otherwise leaves a large empty gap above an artifact card.
  const hasResponseBody = groupedParts.some((part) => {
    const kind = partKind(part)
    return kind === 'text' || kind === 'tool' || kind === 'created_files'
  })

  // Count the source parts consumed by each group. Folding a synthetic file row
  // then leaves the identities of the surrounding message parts intact.
  let nextPartIndex = 0
  groupedParts.forEach((part, index) => {
    if (part.type === 'created_files') {
      // A later save can move a filename to another row, including after intervening text.
      // Keep each disclosure keyed directly in the message's list of siblings.
      part.files.forEach((versions, fileIndex) => {
        partElements.push(
          <div
            key={`file-${versions.latest.filename}`}
            className={`my-2 inline-flex max-w-full align-top ${fileIndex === 0 ? 'ps-4' : ''} ${fileIndex === part.files.length - 1 ? 'pe-4' : 'pe-2'}`}
          >
            <CreatedFileVersionGroup versions={versions} />
          </div>,
        )
      })
      return
    }
    const partIndex = nextPartIndex
    nextPartIndex += part.type === 'reasoning_group' ? part.items.length : 1
    if (part.type === 'data-acp-compaction') {
      appendPart(<AcpCompactionNotice compaction={part.data} />, partIndex)
      return
    }
    const isLastPart = index === groupedParts.length - 1

    switch (partKind(part)) {
      case 'reasoning_group': {
        const reasoningGroupPart = part as ReasoningGroupUIPart
        appendPart(
          <ReasoningGroup
            parts={reasoningGroupPart.items}
            isStreaming={isStreaming}
            isLastPartInMessage={isLastPart}
            hasTextPart={hasResponseBody}
            reasoningTime={reasoningTime}
            reasoningStartTimes={reasoningStartTimes}
            mcpTools={mcpTools}
          />,
          partIndex,
        )
        break
      }
      case 'text':
        appendPart(
          <TextPart
            part={part as TextUIPart}
            isStreaming={isStreaming}
            messageId={messageId}
            sources={sources}
            haystackReferences={haystackReferences}
          />,
          partIndex,
        )
        break
      case 'tool':
        appendPart(<ArtifactMessagePart part={part as ToolOrDynamicToolUIPart} />, partIndex)
        break
    }
  })

  return partElements
}

export const AssistantMessage = memo(
  ({
    message,
    sources: threadSources,
    isStreaming,
    holdFiles = false,
    isLastMessage = false,
    isLastAssistantMessage = false,
    lastAssistantAction,
    activity,
  }: AssistantMessageProps) => {
    // Memoize filtering and grouping to avoid recomputing on every render
    const groupedParts = useMemo(() => {
      const grouped = groupMessageParts(filterMessageParts(message.parts))
      return holdFiles ? grouped.filter((part) => part.type !== 'created_files') : grouped
    }, [message.parts, holdFiles])

    // Read metadata fields directly. During streaming `message.parts` grows every
    // token, so `groupedParts` — and therefore `partElements` below — already
    // recompute each token; stabilizing these references with a per-field
    // `JSON.stringify` bought nothing then and cost a stringify of `sources` /
    // `mcpTools` on every render. Once streaming stops the metadata reference is
    // stable, so `partElements` memoizes on the stable field references.
    const metadata = message.metadata
    const reasoningTime = metadata?.reasoningTime ?? emptyReasoningTime
    const reasoningStartTimes = metadata?.reasoningStartTimes
    const sources = threadSources ?? metadata?.sources
    const haystackReferences = metadata?.haystackReferences
    const mcpTools = metadata?.mcpTools

    // Memoize part element creation to prevent recreating React nodes unnecessarily
    const partElements: ReactNode[] = useMemo(
      () =>
        mountMessageParts(
          groupedParts,
          isStreaming,
          message.id,
          reasoningTime,
          reasoningStartTimes,
          sources,
          haystackReferences,
          mcpTools,
        ),
      [
        groupedParts,
        isStreaming,
        message.id,
        reasoningTime,
        reasoningStartTimes,
        sources,
        haystackReferences,
        mcpTools,
      ],
    )

    const copyText = useMemo(() => extractTextFromParts(message.parts), [message.parts])

    const hasWidgets = useMemo(
      () =>
        message.parts.some(
          (part) => part.type === 'text' && /<widget:(weather-forecast|link-preview|map|ask)/.test(part.text),
        ),
      [message.parts],
    )

    // An artifact is a tall block of its own, so it doesn't need the last-message
    // height reserve — and applying it would leave empty space that pushes the
    // artifact toward the middle of the viewport ("floating" too far down). Match the
    // same condition that actually lifts the card out (streaming or verified-ok), so a
    // last message whose only render_html call FAILED still gets the normal reserve.
    const hasArtifact = useMemo(
      () => message.parts.some((part) => isRenderHtmlPart(part) && artifactRendersStandalone(part)),
      [message.parts],
    )

    const lastPartType = groupedParts.at(-1)?.type
    const spaceBeforeActions =
      hasWidgets ||
      lastPartType === 'reasoning_group' ||
      lastPartType === 'data-acp-compaction' ||
      lastPartType === 'created_files'

    const showCopyOnHover = !isLastAssistantMessage

    return (
      <div
        data-message-id={message.id}
        data-quotable-message-id={message.id}
        className={showCopyOnHover ? 'group/assistant-message' : undefined}
        style={isLastMessage && isStreaming && !hasArtifact ? { minHeight: lastMessageMinHeight } : undefined}
      >
        {/* A heading per response for screen-reader heading navigation, and the
            target of "Go to latest response". Shown only while it has focus. */}
        <h2
          id={responseHeadingId(message.id)}
          tabIndex={-1}
          className="sr-only select-none scroll-mt-[calc(var(--header-inset)+1rem)] rounded-md text-[length:var(--font-size-sm)] font-medium text-muted-foreground focus:not-sr-only focus:outline-2 focus:outline-offset-2 focus:outline-ring"
        >
          <Trans>Response</Trans>
        </h2>
        {(groupedParts.length > 0 || !activity) && partElements}
        {activity}
        {!isStreaming && (copyText || lastAssistantAction) && (
          <div
            className={`flex items-center gap-1.5 px-4 ${spaceBeforeActions ? 'mt-1' : '-mt-6'} ${showCopyOnHover ? 'md:pointer-events-none md:opacity-0 md:transition-opacity md:group-hover/assistant-message:pointer-events-auto md:group-hover/assistant-message:opacity-100' : ''}`}
          >
            {copyText && <CopyMessageButton text={copyText} />}
            {lastAssistantAction}
          </div>
        )}
      </div>
    )
  },
  // Custom comparison to prevent re-renders when content hasn't actually changed
  (prevProps, nextProps) => {
    return (
      prevProps.message.id === nextProps.message.id &&
      prevProps.message.parts === nextProps.message.parts &&
      prevProps.message.metadata === nextProps.message.metadata &&
      prevProps.sources === nextProps.sources &&
      prevProps.isStreaming === nextProps.isStreaming &&
      prevProps.holdFiles === nextProps.holdFiles &&
      prevProps.isLastMessage === nextProps.isLastMessage &&
      prevProps.isLastAssistantMessage === nextProps.isLastAssistantMessage &&
      prevProps.lastAssistantAction === nextProps.lastAssistantAction &&
      prevProps.activity === nextProps.activity
    )
  },
)

AssistantMessage.displayName = 'AssistantMessage'
