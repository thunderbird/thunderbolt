/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-node'
import { redactGenAiSpan } from '@shared/telemetry/gen-ai'

/** Replaces the SDK's detected resource (host, process, command line, OTEL_RESOURCE_ATTRIBUTES). */
const posthogResource = resourceFromAttributes({ 'service.name': 'thunderbolt-backend' })

/**
 * Batch-export only our GenAI spans, stripped to allowlisted attributes and a minimal resource.
 * PostHog stores everything it receives (it has no privacy mode on this path), so this is the privacy boundary.
 */
export const createPostHogSpanProcessor = (exporter: SpanExporter): SpanProcessor => {
  const batch = new BatchSpanProcessor(exporter)
  return {
    onStart: () => {},
    onEnd: (span) => {
      const redacted = redactGenAiSpan(span, posthogResource)
      if (redacted) {
        batch.onEnd(redacted)
      }
    },
    forceFlush: () => batch.forceFlush(),
    shutdown: () => batch.shutdown(),
  }
}
