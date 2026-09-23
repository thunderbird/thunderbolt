# Voice Mode

Voice mode turns the chat composer into a spoken conversation: one utterance at a time, transcribed
and sent through the **same** chat send path a typed message uses, with the reply spoken back.
Talking over the assistant cuts it off.

```text
mic → capture worklet (16 kHz) → endpointer → engine.transcribe → transcript filter
    → reply (chat) → content-part parse → sentence aggregator → toSpeakable
    → engine.synthesize → playback queue
```

| Aspect             | Detail                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry point        | `VoiceModeButton` takes the send-button slot while the composer is empty and idle (`emptyStateAction`, [`chat-prompt-input.tsx:869`](../../src/components/chat/chat-prompt-input.tsx)). A session covers the prompt box in place with `VoiceModeComposer`, not a detached widget. |
| Default engine     | Tinfoil's confidential enclave, via the attested `/tinfoil` HPKE proxy ([`thunderbolt-engine.ts`](../../src/voice/engine/thunderbolt-engine.ts))                                                                                                                                  |
| Alternative engine | Any OpenAI-compatible `/v1/audio/*` server, behind `experimental_feature_voice` ([`openai-compatible-engine.ts`](../../src/voice/engine/openai-compatible-engine.ts))                                                                                                             |
| Stored             | The transcript and the reply, as ordinary chat messages. Never audio                                                                                                                                                                                                              |

A voice turn is a real chat turn: ordinary bubbles, the selected model, tools, history,
persistence, and encryption when [E2E encryption](./e2e-encryption.md) is on. The prompt builder
cannot tell the two apart, so voice needs a signal of its own (see
[Telling the model it is speaking](#telling-the-model-it-is-speaking)).

## What the experimental flag gates

`experimental_feature_voice` defaults to `'false'`
([`src/defaults/settings.ts:55`](../../src/defaults/settings.ts)) and is read at boot in
`step5_get_settings` ([app-initialization.md](./app-initialization.md)).

| Gated                             | Where                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------- |
| The `/settings/voice` route       | [`src/app.tsx:271`](../../src/app.tsx)                                          |
| The settings sidebar nav item     | [`settings-sidebar.tsx:86`](../../src/layout/sidebar/settings-sidebar.tsx)      |
| The command-palette entry         | [`navigation.ts:59`](../../src/search/commands/navigation.ts) (`gate: 'voice'`) |
| The custom-provider engine branch | [`router.ts:21`](../../src/voice/engine/router.ts)                              |

The composer button is not gated: every user can start a voice session. The flag only decides
whether they may point it at something other than the hosted engine.

## Where the audio goes

### Hosted engine (default)

STT and TTS use `/v1/audio/transcriptions` and `/v1/audio/speech`. There is no voice-specific
backend route; the pass-through, its SSRF guard and the attestation lifecycle are in
[managed-inference.md](./managed-inference.md#confidential-tier--v1tinfoil).

- **Only speech leaves the device, not a live mic stream.** The endpointer commits one utterance
  after a trailing-silence window and the engine posts that single WAV
  ([`vad.ts`](../../src/voice/audio/vad.ts), `encodeWav` in
  [`audio-engine.ts`](../../src/voice/engine/audio-engine.ts)).
- **Audio is never persisted.** Frames are in-memory `Float32Array`s and synthesized audio goes
  straight onto a Web Audio graph; only the transcript and reply are stored, via `chat.sendMessage`
  ([`chat-reply.ts`](../../src/voice/chat-reply.ts)).
- **Audio is not metered.** Admission and usage receipts apply only to `POST /v1/chat/completions`
  (`isManagedChat`, [`tinfoil/routes.ts:244`](../../backend/src/tinfoil/routes.ts)); `/audio/*` is
  authenticated and rate-limited but consumes no inference quota.
- **No `TINFOIL_API_KEY` means no default engine**: the route answers
  `503 Tinfoil provider not configured`, so a self-hosted deployment needs the experimental flag and
  an OpenAI-compatible endpoint.

### Custom OpenAI-compatible engine

[`openai-compatible-engine.ts`](../../src/voice/engine/openai-compatible-engine.ts) points at any
server exposing OpenAI-shaped `/v1/audio/*`: another provider, or a local server such as
Kokoro-FastAPI, speaches or LocalAI. Plain fetch through the app's `http` client with the user's own
bearer key, no HPKE proxy.

- **CORS and mixed content cause most support questions.** The server's CORS must allow the app
  origin, and an `http://localhost` server is mixed-content-blocked from an `https` page.
- **Nothing about the app or its user reaches the endpoint** beyond the audio and the user's key.
  `http` is the header-hook-free client for external APIs ([`http.ts:252`](../../src/lib/http.ts));
  the device, `X-App-Version` and `X-App-Language` headers belong to the backend client and are
  guarded by a backend-origin check.
- **The provider config is device-local, not synced** (API key plus machine-specific URL;
  `VoiceProviderConfig`, [`local-settings-store.ts:15`](../../src/stores/local-settings-store.ts)).
  The router reads it at session start, so a change applies next session.

### Telemetry

Nothing under `src/voice/` emits telemetry, hence no voice entry in
[TELEMETRY.md](../../TELEMETRY.md). The hosted engine inherits `tinfoil_attestation` from the system
Tinfoil client ([`tinfoil-client.ts:117`](../../src/ai/tinfoil-client.ts)), since `engine.load()`
primes attestation.

## The loop

[`src/voice/session.ts`](../../src/voice/session.ts) owns the realtime loop and is engine- and
chat-agnostic: it takes a `VoiceEngine` and a `reply` function, so one implementation serves web,
desktop and mobile.

- **Capture.** The `AudioContext` runs at the mic's native rate (a `MediaStreamSource` cannot cross
  sample rates), so [`capture-worklet.js`](../../public/voice/capture-worklet.js) resamples to
  16 kHz in fixed 512-sample (~32 ms) frames. Plain JS in `public/` so `audioWorklet.addModule` gets
  the right MIME type and no bundler transform.
- **Endpointing is energy-based, with no model on the client**, and sized to send only speech to
  STT. The state machine ([`endpointer.ts`](../../src/voice/audio/endpointer.ts)) is split out of
  `vad.ts` to unit-test without `getUserMedia`. A streaming STT with server-side endpointing could
  supersede it.

  | Constant             | Value       | Role                                 |
  | -------------------- | ----------- | ------------------------------------ |
  | `speechRmsThreshold` | 0.015       | energy floor for a speech frame      |
  | `minSpeechFrames`    | 8 (~256 ms) | sustained speech that commits a turn |
  | `endSilenceFrames`   | 45 (~1.4 s) | trailing silence that ends the turn  |
  | preroll              | 4 frames    | kept so the onset is not clipped     |

- **Barge-in is full duplex.** Mic and VAD run while the assistant thinks and speaks; only `'idle'`
  silences the gate ([`session.ts:86`](../../src/voice/session.ts)). Sustained speech aborts the
  turn, flushes queued audio and returns to listening, the triggering audio buffered as the next
  utterance.
- **An interruption always yields a replacement turn**, because `onSpeechStart` fires at the same
  threshold that guarantees a commit (`minSpeechFrames`). Only the browser's echo canceller stops
  the assistant hearing itself; the two constants above are the knobs if it interrupts itself.
- **The reply is polled, not pushed.** `createChatReply` sends the transcript through the current
  `Chat` instance and polls `chat.messages` every 40 ms, yielding deltas so synthesis starts
  mid-generation. It baselines on the message count before sending so it reads this turn's message;
  abort calls `chat.stop()`.
- **Content parts are parsed before sentence aggregation, not after.**
  `parseContentPartsIncremental` and `partsToSpeech` run first, and only that clean text reaches the
  `SentenceAggregator` ([`session.ts:135`](../../src/voice/session.ts)); the other order splits a
  punctuation-heavy widget tag into fragments whose internals leak to TTS. Parser state is threaded
  so each token parses only the appended tail.
- **Aggregation optimizes time-to-first-audio.** The first chunk flushes at the earliest clause
  break past 20 characters, or the last word boundary by 48
  ([`aggregator.ts`](../../src/voice/aggregator.ts)); later chunks flush on sentence boundaries,
  guarding split decimals, known abbreviations and inline code.
- **`speaking` holds until playback drains**, since synthesis enqueues faster than playback plays
  and flipping to `listening` early makes the VAD hear the assistant's own tail as a user turn
  ([`session.ts:205`](../../src/voice/session.ts)).
- **Two earcons carry the state the user is not looking at**: a rising pair at mic open, the same
  interval falling and quieter at handoff ([`earcon.ts`](../../src/voice/audio/earcon.ts)). Both are
  shorter than `minSpeechFrames × 32 ms` (pinned by `earcon.test.ts`) and play through
  `destination`, so they cannot trigger barge-in.

## The engine contract

`VoiceEngine` ([`types.ts`](../../src/voice/engine/types.ts)) is the only platform-swappable seam:
`load`, `transcribe`, `synthesize`, `dispose`. The rest of the loop talks solely to it, which is
what makes barge-in identical across engines. Both shipped engines come from `createAudioEngine`
([`audio-engine.ts`](../../src/voice/engine/audio-engine.ts)), which owns request/response
orchestration and the WAV codec; they differ only in the injected `AudioTransport`, which must:

- **forward the per-turn `AbortSignal`** to its fetch, or an aborted turn keeps running against the
  provider;
- **hand back non-2xx responses rather than throwing**, so the engine can surface the provider's
  error body.

`createVoiceEngine` ([`router.ts`](../../src/voice/engine/router.ts)) picks between them:
Thunderbolt is hard-wired unless the flag is on **and** a custom config with a non-empty base URL
exists, so a stale config left by a disabled flag can never be used.

## Speech sanitation

### Output: `toSpeakable`

Raw markdown reads as "asterisk asterisk", code is read aloud and emoji become their names.
`toSpeakable` ([`speakable.ts`](../../src/voice/speakable.ts)) runs per aggregated chunk and returns
`''` for pure markup, so the caller skips synthesis.

- Substantive widgets become a spoken pointer to the on-screen UI ("Take a look at the map on
  screen.").
- Inline-reference widgets, citation markers and display math are dropped or pointed at, never read.
- Widget internals never reach it: `partsToSpeech` replaced the whole widget part upstream.

### Input: the Whisper filler filter

On near-silent or noise-only audio Whisper returns its most common training captions ("Thanks for
watching", "Please subscribe", a bare "you") rather than empty text.
[`transcript-filter.ts`](../../src/voice/transcript-filter.ts) drops a transcript that is nothing
but such filler. The list is deliberately narrow: courtesies a user genuinely says ("thank you",
"thanks", "bye") are **not** in it, because dropping a real sign-off is worse than answering a
noise-triggered one.

## Telling the model it is speaking

[`voice-mode.ts`](../../src/voice/voice-mode.ts) carries a process-wide "voice active" flag;
`aiFetchStreamingResponse` reads it and injects `voiceModeSystemNote` as a volatile system note for
voice turns only ([`src/ai/fetch.ts:906`](../../src/ai/fetch.ts)). The note says replies are read
aloud (short, no markdown or URLs), the voice is fixed, and questions about itself are answered from
that context instead of a web search.

**The flag is tab-global** and `aiFetchStreamingResponse` is the shared send path for every AI call,
so a non-voice call during a live session (title generation) also gets the note. Accepted; the
module comment records the fix (a per-request `voiceMode` flag threaded through the send).

`voiceModeSystemNote` stays English like every model-facing string ([AGENTS.md](../../AGENTS.md)).
The widget announcements and equation pointer in `speakable.ts` are _spoken to the user_, so they
are `msg` descriptors resolved at call time, not module scope.

## Invariants that will bite

- **Release every `AudioContext` on stop.** A session owns three (VAD capture, playback, engine
  decode) and `stop()` closes all three ([`session.ts:264`](../../src/voice/session.ts)). Missing
  one leaks a context per cycle, and the browser cap of around six kills voice after a few
  toggles.
- **Both halves of startup must settle.** `start()` runs `engine.load()` and `gate.start()` under
  `Promise.allSettled`, not `all`: tearing down mid-flight destroys a gate that has not yet acquired
  the mic, and the pending `getUserMedia` resolves into a live mic no one holds. The gate is born
  muted so speech during attestation cannot commit against an engine that cannot yet transcribe; a
  `stopped` latch handles a `stop()` landing mid-startup.
- **`navigator.mediaDevices` needs a secure context.** WKWebView hides the property outside one, so
  a Tauri **dev** build on `http://localhost` fails before `getUserMedia` is callable;
  `MediaDevicesUnavailableError` ([`voice-error.ts`](../../src/voice/voice-error.ts)) makes that
  actionable rather than a bare `TypeError`. Packaged builds are unaffected.
- **Native microphone permissions are per platform.** `NSMicrophoneUsageDescription` in
  [`Info.plist`](../../src-tauri/Info.plist) (macOS/iOS TCC blocks, and can crash, mic access
  without it); `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` and the microphone feature in
  [`AndroidManifest.xml`](../../src-tauri/gen/android/app/src/main/AndroidManifest.xml). Wider
  picture: [mobile-setup.md](../development/mobile-setup.md).
- **Keep the voice runtime out of the entry bundle.** The composer hosting the trigger is always
  mounted, so `useVoiceSession` imports the session, engine router and chat reply dynamically on
  start ([`use-voice-session.ts:89`](../../src/voice/ui/use-voice-session.ts)); the settings page
  sits outside `routeChunkLoaders`, lazy but never prefetched
  ([`src/app.tsx:117`](../../src/app.tsx)). A static import of `@/voice/session` in the composer
  tree undoes both.
- **Read the flag from the database in `start()`, not from a reactive hook**, which returns `false`
  until its query resolves and would silently bypass a configured custom provider on a cold start.
  `use-voice-session.ts` awaits `getSettings` alongside the dynamic imports.
- **Tear the session down when the composer unmounts.** Chat navigation or HMR otherwise leaves an
  orphaned mic, VAD and `AudioContext` bound to the old chat, and starting again elsewhere sends one
  utterance to two chats.

## Source map

| Area                              | File                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Realtime loop                     | [`src/voice/session.ts`](../../src/voice/session.ts)                                                 |
| Mic capture + worklet plumbing    | [`src/voice/audio/vad.ts`](../../src/voice/audio/vad.ts)                                             |
| Resampling worklet                | [`public/voice/capture-worklet.js`](../../public/voice/capture-worklet.js)                           |
| Endpointing state machine         | [`src/voice/audio/endpointer.ts`](../../src/voice/audio/endpointer.ts)                               |
| Gapless playback + barge-in flush | [`src/voice/audio/playback.ts`](../../src/voice/audio/playback.ts)                                   |
| Audible cues                      | [`src/voice/audio/earcon.ts`](../../src/voice/audio/earcon.ts)                                       |
| Engine contract                   | [`src/voice/engine/types.ts`](../../src/voice/engine/types.ts)                                       |
| Shared STT/TTS orchestration      | [`src/voice/engine/audio-engine.ts`](../../src/voice/engine/audio-engine.ts)                         |
| Hosted (enclave) engine           | [`src/voice/engine/thunderbolt-engine.ts`](../../src/voice/engine/thunderbolt-engine.ts)             |
| Custom OpenAI-compatible engine   | [`src/voice/engine/openai-compatible-engine.ts`](../../src/voice/engine/openai-compatible-engine.ts) |
| Engine selection                  | [`src/voice/engine/router.ts`](../../src/voice/engine/router.ts)                                     |
| Chat-backed reply                 | [`src/voice/chat-reply.ts`](../../src/voice/chat-reply.ts)                                           |
| Sentence aggregation              | [`src/voice/aggregator.ts`](../../src/voice/aggregator.ts)                                           |
| Text → speech sanitation          | [`src/voice/speakable.ts`](../../src/voice/speakable.ts)                                             |
| Whisper hallucination filter      | [`src/voice/transcript-filter.ts`](../../src/voice/transcript-filter.ts)                             |
| Error mapping                     | [`src/voice/voice-error.ts`](../../src/voice/voice-error.ts)                                         |
| Voice self-context note           | [`src/voice/voice-mode.ts`](../../src/voice/voice-mode.ts)                                           |
| React lifecycle wrapper           | [`src/voice/ui/use-voice-session.ts`](../../src/voice/ui/use-voice-session.ts)                       |
| Composer trigger and overlay      | [`src/voice/ui/`](../../src/voice/ui/)                                                               |
| Provider settings page            | [`src/settings/voice.tsx`](../../src/settings/voice.tsx)                                             |
| Device-local provider config      | [`src/stores/local-settings-store.ts`](../../src/stores/local-settings-store.ts)                     |

## Related

- [Managed Inference](./managed-inference.md): the `/tinfoil` pass-through, its enclave guard and
  its metering.
- [Chat Runtime](./chat-runtime.md): the send path a voice turn reuses.
- [Widgets](../features/widgets.md): the content-part parser voice strips before synthesis.
- [App Initialization](./app-initialization.md): where `experimental_feature_voice` is read at boot.
