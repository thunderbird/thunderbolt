/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Voice provider settings (THU-718). Pick the hosted Thunderbolt engine or point
 * voice mode at any OpenAI-compatible `/v1/audio/*` endpoint — another provider
 * or a self-hosted local server (Kokoro-FastAPI, speaches, LocalAI, …). Config is
 * device-local (holds a key + machine-specific URL) and applies on the next voice
 * turn.
 */
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/ui/page-header'
import { SectionCard } from '@/components/ui/section-card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { type DiscoveredModels, fetchOpenAiModels, testOpenAiConnection } from '@/voice/engine/openai-compatible-engine'
import { type VoiceProviderConfig, useLocalSettingsStore } from '@/stores/local-settings-store'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { useState } from 'react'

type ConnState = { status: 'idle' | 'testing' | 'ok' | 'error'; detail?: string }

const Field = ({
  id,
  label,
  hint,
  value,
  placeholder,
  type = 'text',
  onChange,
}: {
  id: string
  label: string
  hint?: string
  value: string
  placeholder?: string
  type?: string
  onChange: (value: string) => void
}) => (
  <div className="flex flex-col gap-1.5">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    {hint && <p className="text-[length:var(--font-size-xs)] text-muted-foreground">{hint}</p>}
  </div>
)

/**
 * A model/voice picker: a dropdown once the server's models are discovered,
 * degrading to the free-text {@link Field} when nothing was returned (server
 * unreachable, or a plain server that doesn't list models). The current value
 * is always selectable even if it isn't in the discovered set (e.g. a value
 * persisted before discovery, or a manually entered id).
 */
const ComboField = ({
  id,
  label,
  hint,
  value,
  placeholder,
  options,
  onChange,
}: {
  id: string
  label: string
  hint?: string
  value: string
  placeholder?: string
  options: string[]
  onChange: (value: string) => void
}) => {
  if (options.length === 0) {
    return <Field id={id} label={label} hint={hint} value={value} placeholder={placeholder} onChange={onChange} />
  }
  const items = value && !options.includes(value) ? [value, ...options] : options
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item} value={item}>
              {item}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-[length:var(--font-size-xs)] text-muted-foreground">{hint}</p>}
    </div>
  )
}

export const VoiceSettingsPage = () => {
  const { t } = useLingui()
  const config = useLocalSettingsStore((s) => s.voiceProvider)
  const setLocalSetting = useLocalSettingsStore((s) => s.setLocalSetting)
  const [ui, setUi] = useState<{ conn: ConnState; models: DiscoveredModels | null; loadingModels: boolean }>({
    conn: { status: 'idle' },
    models: null,
    loadingModels: false,
  })

  const update = (patch: Partial<VoiceProviderConfig>) => setLocalSetting('voiceProvider', { ...config, ...patch })
  const isCustom = config.kind === 'openai-compatible'
  const canTest = isCustom && config.baseUrl.trim().length > 0

  const runTest = async () => {
    setUi((s) => ({ ...s, conn: { status: 'testing' } }))
    const result = await testOpenAiConnection(config)
    setUi((s) => ({ ...s, conn: { status: result.ok ? 'ok' : 'error', detail: result.detail } }))
  }

  const loadModels = async () => {
    setUi((s) => ({ ...s, loadingModels: true }))
    const models = await fetchOpenAiModels(config.baseUrl, config.apiKey)
    setUi((s) => ({ ...s, models, loadingModels: false }))
  }

  const sttOptions = ui.models?.stt ?? []
  const ttsOptions = (ui.models?.tts ?? []).map((m) => m.id)
  const voiceOptions = ui.models?.tts.find((m) => m.id === config.ttsModel)?.voices ?? []

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 p-4 pb-12">
      <PageHeader title={t`Voice`} />

      <SectionCard title={t`Voice engine`}>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="voice-provider">
              <Trans>Provider</Trans>
            </Label>
            <Select value={config.kind} onValueChange={(kind) => update({ kind: kind as VoiceProviderConfig['kind'] })}>
              <SelectTrigger id="voice-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="thunderbolt">
                  <Trans>Thunderbolt (hosted, private)</Trans>
                </SelectItem>
                <SelectItem value="openai-compatible">
                  <Trans>Custom — OpenAI-compatible endpoint</Trans>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
              {isCustom ? (
                <Trans>
                  Point at any server exposing /v1/audio/transcriptions and /v1/audio/speech. Its CORS must allow this
                  app’s origin.
                </Trans>
              ) : (
                <Trans>Speech-to-text and text-to-speech run in Thunderbolt’s confidential enclave.</Trans>
              )}
            </p>
          </div>

          {isCustom && (
            <>
              <Field
                id="voice-base-url"
                label={t`Base URL`}
                placeholder="http://localhost:8880/v1"
                hint={t`Include the version prefix (e.g. /v1). Then hit “Load models” to populate the pickers below.`}
                value={config.baseUrl}
                onChange={(baseUrl) => update({ baseUrl })}
              />
              <Field
                id="voice-api-key"
                label={t`API key`}
                type="password"
                hint={t`Optional — leave blank for local servers that don’t require auth.`}
                value={config.apiKey}
                onChange={(apiKey) => update({ apiKey })}
              />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <ComboField
                  id="voice-stt-model"
                  label={t`STT model`}
                  placeholder="whisper-large-v3-turbo"
                  options={sttOptions}
                  value={config.sttModel}
                  onChange={(sttModel) => update({ sttModel })}
                />
                <ComboField
                  id="voice-tts-model"
                  label={t`TTS model`}
                  placeholder="kokoro"
                  options={ttsOptions}
                  value={config.ttsModel}
                  onChange={(ttsModel) => update({ ttsModel })}
                />
              </div>
              <ComboField
                id="voice-tts-voice"
                label={t`TTS voice`}
                placeholder="af_bella"
                options={voiceOptions}
                value={config.ttsVoice}
                onChange={(ttsVoice) => update({ ttsVoice })}
              />

              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={loadModels} disabled={!canTest || ui.loadingModels}>
                    {ui.loadingModels && <Loader2 className="size-4 animate-spin" />}
                    <Trans>Load models</Trans>
                  </Button>
                  <Button type="button" onClick={runTest} disabled={!canTest || ui.conn.status === 'testing'}>
                    {ui.conn.status === 'testing' && <Loader2 className="size-4 animate-spin" />}
                    <Trans>Test connection</Trans>
                  </Button>
                </div>

                {ui.models !== null && ui.models.stt.length === 0 && ui.models.tts.length === 0 && (
                  <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
                    <Trans>
                      No models returned (server unreachable, or it doesn’t list models). Enter model and voice ids
                      manually.
                    </Trans>
                  </p>
                )}

                {ui.conn.status === 'ok' && (
                  <p className="flex items-center gap-1.5 text-[length:var(--font-size-sm)] text-primary">
                    <CheckCircle2 className="size-4 shrink-0" />
                    {ui.conn.detail}
                  </p>
                )}
                {ui.conn.status === 'error' && (
                  <p className="flex items-start gap-1.5 text-[length:var(--font-size-sm)] text-destructive">
                    <XCircle className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 break-words">{ui.conn.detail}</span>
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </SectionCard>
    </div>
  )
}

export default VoiceSettingsPage
