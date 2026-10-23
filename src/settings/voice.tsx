/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { PageHeader } from '@/components/ui/page-header'
import { SectionCard } from '@/components/ui/section-card'
import { useAllAgents } from '@/dal/agents'
import { isAgentVoiceConfigured } from '@/voice/agent-voice'

/** Voice models belong to each agent, matching the provider used by its chats. */
export const VoiceSettingsPage = () => {
  const { t } = useLingui()
  const agents = useAllAgents()

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 p-4 pb-12">
      <PageHeader title={t`Voice`} />
      <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
        <Trans>Each agent defines its own speech-to-text and text-to-speech models.</Trans>
      </p>
      {agents.map((agent) => (
        <SectionCard key={agent.id} title={agent.name}>
          {isAgentVoiceConfigured(agent.voice) ? (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-[length:var(--font-size-sm)] text-muted-foreground">
                  <Trans>Provider</Trans>
                </dt>
                <dd>Tinfoil</dd>
              </div>
              <div>
                <dt className="text-[length:var(--font-size-sm)] text-muted-foreground">
                  <Trans>STT model</Trans>
                </dt>
                <dd>{agent.voice.sttModel}</dd>
              </div>
              <div>
                <dt className="text-[length:var(--font-size-sm)] text-muted-foreground">
                  <Trans>TTS model</Trans>
                </dt>
                <dd>{agent.voice.ttsModel}</dd>
              </div>
              <div>
                <dt className="text-[length:var(--font-size-sm)] text-muted-foreground">
                  <Trans>TTS voice</Trans>
                </dt>
                <dd>{agent.voice.ttsVoice}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
              {agent.voice?.provider === 'fireworks' ? (
                <Trans>Fireworks voice models have not been selected yet. Voice is unavailable for this agent.</Trans>
              ) : (
                <Trans>Voice is not available for this agent.</Trans>
              )}
            </p>
          )}
        </SectionCard>
      ))}
    </div>
  )
}

export default VoiceSettingsPage
