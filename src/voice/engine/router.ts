/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Voice engine selection (THU-700 / THU-718).
 *
 * The default is the Thunderbolt-hosted STT/TTS (Tinfoil-backed, enclave-private)
 * and it is hard-wired: pointing voice at a custom OpenAI-compatible endpoint is
 * gated behind the `experimental_feature_voice` flag (the same flag that reveals
 * the Voice settings page). When the flag is off we always use Thunderbolt, even
 * if a stale custom config lingers in device-local settings. Read at session
 * start, so a settings change applies on the next voice turn.
 */
import { getLocalSetting } from '@/stores/local-settings-store'
import { createOpenAiCompatibleEngine } from './openai-compatible-engine'
import { createThunderboltEngine } from './thunderbolt-engine'
import type { VoiceEngine } from './types'

export const createVoiceEngine = (customProviderEnabled: boolean): VoiceEngine => {
  const config = getLocalSetting('voiceProvider')
  if (customProviderEnabled && config.kind === 'openai-compatible' && config.baseUrl.trim().length > 0) {
    return createOpenAiCompatibleEngine(config)
  }
  return createThunderboltEngine()
}
