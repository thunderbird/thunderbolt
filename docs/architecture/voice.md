# Voice Mode

Voice mode turns the chat composer into a spoken conversation. The app opens the microphone, waits
for you to finish an utterance, transcribes it, sends the transcript through the **same** chat send
path a typed message uses, and speaks the reply back — and you can cut the assistant off at any
point by talking over it.

Two consequences of reusing the normal send path are worth stating up front, because they explain
most of the design. A voice turn is a real chat turn: it appears as ordinary chat bubbles, uses the
selected model, tools, history and persistence, and is stored (and encrypted, when
[E2E encryption](./e2e-encryption.md) is on) exactly like anything else you typed. And the prompt
builder cannot tell the two apart, which is why voice needs a signal of its own to tell the model it
is speaking aloud — see [Telling the model it is speaking](#telling-the-model-it-is-speaking).

The entry point is the composer. `VoiceModeButton` occupies the send-button slot while the composer
is empty and idle (`emptyStateAction`,
[`src/components/chat/chat-prompt-input.tsx:869`](../../src/components/chat/chat-prompt-input.tsx));
starting a session covers the prompt box in place with `VoiceModeComposer` rather than opening a
detached widget.

## The flag gates the settings page, not the feature

`experimental_feature_voice` defaults to `'false'`
([`src/defaults/settings.ts:55`](../../src/defaults/settings.ts)) and is read at boot in
`step5_get_settings` ([app-initialization.md](./app-initialization.md)). It gates four things:

| Gated                             | Where                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| The `/settings/voice` route       | [`src/app.tsx:271`](../../src/app.tsx)                                                              |
| The settings sidebar nav item     | [`src/layout/sidebar/settings-sidebar.tsx:86`](../../src/layout/sidebar/settings-sidebar.tsx)       |
| The command-palette entry         | [`src/search/commands/navigation.ts:59`](../../src/search/commands/navigation.ts) (`gate: 'voice'`) |
| The custom-provider engine branch | [`src/voice/engine/router.ts:21`](../../src/voice/engine/router.ts)                                 |

It does **not** gate the composer button, and `VoiceModeButton` contains no flag check. Every user
can therefore start a voice session; what the flag decides is whether they may point it somewhere
other than the hosted engine. That is deliberate — the settings page exists only to configure a
custom provider — but it means "voice is off by default" is false, and anyone reasoning about where
microphone audio goes has to read the next section rather than the flag.

## Where the audio goes

The default engine sends speech-to-text and text-to-speech to Tinfoil's confidential enclave over
the OpenAI-compatible `/v1/audio/transcriptions` and `/v1/audio/speech` endpoints, reached through
the app's existing attested `/tinfoil` HPKE proxy
([`src/voice/engine/thunderbolt-engine.ts`](../../src/voice/engine/thunderbolt-engine.ts)). No
voice-specific backend route exists; the pass-through, its SSRF guard and the client-side attestation
lifecycle are documented in
[managed-inference.md](./managed-inference.md#confidential-tier--v1tinfoil).

Four properties of that path are specific to voice:

- **Only speech leaves the device, not a live mic stream.** The endpointer commits one utterance
  after a trailing-silence window and the engine posts that single WAV
  ([`src/voice/audio/vad.ts`](../../src/voice/audio/vad.ts),
  `encodeWav` in [`src/voice/engine/audio-engine.ts`](../../src/voice/engine/audio-engine.ts)).
- **Audio is never persisted.** Captured frames are in-memory `Float32Array`s and synthesized audio
  is scheduled straight onto a Web Audio graph. What is stored is the transcript and the reply, as
  normal chat messages, because the reply goes through `chat.sendMessage`
  ([`src/voice/chat-reply.ts`](../../src/voice/chat-reply.ts)).
- **Audio is not metered.** The `/tinfoil` proxy applies admission and issues a usage receipt only
  for `POST /v1/chat/completions` (`isManagedChat`,
  [`backend/src/tinfoil/routes.ts:244`](../../backend/src/tinfoil/routes.ts)). `/audio/*` traffic is
  authenticated and rate-limited like the rest of the route but consumes no inference quota.
- **A self-hosted deployment without `TINFOIL_API_KEY` has no working default engine.** The route
  answers `503 Tinfoil provider not configured` when the key is unset, and the only alternative
  engine sits behind the experimental flag, so getting voice working there means enabling the flag
  and pointing it at an OpenAI-compatible endpoint.

The alternative engine
([`src/voice/engine/openai-compatible-engine.ts`](../../src/voice/engine/openai-compatible-engine.ts))
points at any server exposing OpenAI-shaped `/v1/audio/*` — another provider, or a local model
server such as Kokoro-FastAPI, speaches or LocalAI. It does a plain fetch through the app's `http`
client with the user's own bearer key, and no HPKE proxy is involved. Two consequences that generate
most of the support questions: the server's own CORS must allow the app origin, and an
`http://localhost` server is mixed-content-blocked from an `https` page. `http` is the
header-hook-free client meant for external APIs
([`src/lib/http.ts:252`](../../src/lib/http.ts)) — the device, `X-App-Version` and `X-App-Language`
headers belong to the authenticated backend client and are guarded by a backend-origin check there
anyway — so nothing about the app or its user reaches a third-party endpoint beyond the audio and
the key the user supplied.

The provider config is device-local rather than synced — it holds an API key and a machine-specific
URL (`VoiceProviderConfig`,
[`src/stores/local-settings-store.ts:15`](../../src/stores/local-settings-store.ts)) — and the router
reads it at session start, so a change applies on the next voice session.

Nothing under `src/voice/` emits telemetry, which is why voice has no entry in
[TELEMETRY.md](../../TELEMETRY.md). The hosted engine does inherit the shared
`tinfoil_attestation` event from the system Tinfoil client
([`src/ai/tinfoil-client.ts:117`](../../src/ai/tinfoil-client.ts)), since priming attestation is what
`engine.load()` does.

## The loop

[`src/voice/session.ts`](../../src/voice/session.ts) owns the whole realtime loop and is both
engine- and chat-agnostic: it takes a `VoiceEngine` and a `reply` function, so the same code runs on
web, desktop and mobile with nothing platform-specific in it.

```text
mic → capture worklet (16 kHz) → endpointer → engine.transcribe → transcript filter
    → reply (chat) → content-part parse → sentence aggregator → toSpeakable
    → engine.synthesize → playback queue
```

**Capture.** The `AudioContext` runs at the microphone's native rate — a `MediaStreamSource` cannot
be connected across sample rates — so [`public/voice/capture-worklet.js`](../../public/voice/capture-worklet.js)
resamples to 16 kHz and emits fixed 512-sample (~32 ms) frames. It lives in `public/` as plain JS so
`audioWorklet.addModule` loads it with the right MIME type and no bundler transform.

**Endpointing is energy-based, with no model on the client.** The state machine in
[`src/voice/audio/endpointer.ts`](../../src/voice/audio/endpointer.ts) is split out of `vad.ts` so it
unit-tests without `getUserMedia`. Three constants define its behaviour: `speechRmsThreshold`
(0.015), `minSpeechFrames` (8 frames, ~256 ms of sustained speech) and `endSilenceFrames` (45
frames, ~1.4 s of trailing silence to end the turn). Four frames of preroll are kept so the onset is
not clipped. This is the crude-but-dependency-free choice, sized to send only speech to the STT
provider; a streaming STT with server-side endpointing could supersede it.

**Barge-in is full duplex, and one constant makes it safe.** The mic and VAD keep running while the
assistant thinks and speaks — only `'idle'` silences the gate
([`src/voice/session.ts:86`](../../src/voice/session.ts)) — so sustained speech aborts the turn,
flushes queued audio and drops back to listening. `onSpeechStart` fires at exactly the same
threshold that guarantees a commit (`minSpeechFrames`), so interrupting the assistant always yields
a replacement turn rather than dead air, and the audio that triggered the interruption stays
buffered and commits as the next utterance. Nothing rejects the assistant's own voice except the
browser's echo canceller; `minSpeechFrames` and `speechRmsThreshold` are the knobs if it starts
interrupting itself.

**The reply is polled, not pushed.** `createChatReply` sends the transcript through the current
`Chat` instance and polls `chat.messages` every 40 ms for the new assistant message, yielding
deltas so synthesis starts mid-generation. It baselines on the message count before sending so it
reads this turn's message rather than the previous one, and aborting calls `chat.stop()`.

**Content parts are parsed before sentence aggregation, not after.** The accumulated reply goes
through `parseContentPartsIncremental` and `partsToSpeech` first, and only that clean speech source
reaches the `SentenceAggregator` ([`src/voice/session.ts:135`](../../src/voice/session.ts)). Doing
it in the other order lets a widget tag full of punctuation split into fragments whose internals leak
to TTS. The parser state is threaded through so each token parses only the appended tail rather than
the whole growing string.

**Aggregation optimizes time-to-first-audio.** The first chunk flushes at the earliest clause break
past 20 characters, or at the last word boundary by 48
([`src/voice/aggregator.ts`](../../src/voice/aggregator.ts)); later chunks flush on sentence
boundaries, with guards against splitting decimals, known abbreviations and inline code.

**The session stays in `speaking` until playback actually drains.** Synthesis enqueues faster than
playback plays, and flipping to `listening` early makes the VAD treat the assistant's own tail as a
user turn ([`src/voice/session.ts:205`](../../src/voice/session.ts)).

Two short synthesized tones carry the state the user cannot see, because the point of speaking is
that they are not looking at the screen: a rising pair when the mic opens, and the same interval
falling, quieter, when an utterance is handed off
([`src/voice/audio/earcon.ts`](../../src/voice/audio/earcon.ts)). Both are shorter than
`minSpeechFrames × 32 ms` — a bound `earcon.test.ts` pins — and play through `destination`, so they
cannot trigger barge-in.

## The engine contract

`VoiceEngine` ([`src/voice/engine/types.ts`](../../src/voice/engine/types.ts)) is the only
platform-swappable seam: `load`, `transcribe`, `synthesize`, `dispose`. Everything else in the loop
talks solely to that interface, which is what makes barge-in behaviour identical across engines.

Both shipped engines are built from `createAudioEngine`
([`src/voice/engine/audio-engine.ts`](../../src/voice/engine/audio-engine.ts)), which owns the
request/response orchestration and the WAV codec; they differ only in the injected `AudioTransport`.
A transport must forward the per-turn `AbortSignal` to its underlying fetch, or an aborted turn keeps
running against the provider, and it must hand back non-2xx responses rather than throwing, so the
engine can surface the provider's error body.

`createVoiceEngine` ([`src/voice/engine/router.ts`](../../src/voice/engine/router.ts)) picks between
them. The Thunderbolt engine is hard-wired unless the flag is on **and** a custom config with a
non-empty base URL exists, so a stale custom config left behind by a disabled flag can never be
used.

## Speech sanitation

The model writes for the eye. Fed raw to TTS, markdown becomes "asterisk asterisk", code is read
aloud and emoji become their names. `toSpeakable`
([`src/voice/speakable.ts`](../../src/voice/speakable.ts)) runs per aggregated chunk and strips the
visual scaffolding down to what a person would say, returning `''` for chunks that are nothing but
markup so the caller can skip synthesis entirely. Substantive widgets become a spoken pointer to the
on-screen UI ("Take a look at the map on screen."); inline-reference widgets, citation markers and
display math are dropped or pointed at rather than read. Widget internals never reach this function
at all, because `partsToSpeech` replaced the whole widget part upstream.

The inverse problem is on the input side. Handed near-silent or noise-only audio, Whisper does not
return empty — it emits its most common training captions ("Thanks for watching", "Please
subscribe", a bare "you"), which would become turns the user never spoke.
[`src/voice/transcript-filter.ts`](../../src/voice/transcript-filter.ts) drops a transcript that is
nothing but such filler. It is deliberately narrow: bare courtesies a user genuinely says to the
assistant — "thank you", "thanks", "bye" — are **not** in the list, because silently dropping a real
sign-off is worse than occasionally answering a noise-triggered one.

## Telling the model it is speaking

Because a voice turn is an ordinary chat turn, the prompt builder needs an out-of-band signal.
[`src/voice/voice-mode.ts`](../../src/voice/voice-mode.ts) carries a process-wide "voice active"
flag; `aiFetchStreamingResponse` reads it and injects `voiceModeSystemNote` as a volatile system
note for voice turns only ([`src/ai/fetch.ts:906`](../../src/ai/fetch.ts)). The note tells the model
its replies are read aloud (keep them short, avoid markdown and URLs), that its voice is fixed, and
that it should answer questions about itself from that context instead of web-searching its own
identity.

The flag is tab-global, and `aiFetchStreamingResponse` is the shared send path for every AI call, so
a non-voice call firing during a live session — title generation, for instance — also receives the
note. That is a known, accepted limitation; the module comment records the fix (thread a per-request
`voiceMode` flag through the send) should it ever matter.

Like every other model-facing string in the repo, `voiceModeSystemNote` stays English on purpose
(see the localization constraints in [AGENTS.md](../../AGENTS.md)). The widget announcements and
equation pointer in `speakable.ts` are _spoken to the user_, so they are `msg` descriptors resolved
at call time, not module scope.

## Invariants that will bite

- **Release every `AudioContext` on stop.** A session owns three: the VAD's capture context, the
  playback context and the engine's decode context. `stop()` closes all three
  ([`src/voice/session.ts:264`](../../src/voice/session.ts)); missing one leaks a context per
  start/stop cycle and the browser cap (around six) breaks voice after a few toggles.
- **Startup races the mic against the engine, and both halves must settle.** `start()` runs
  `engine.load()` and `gate.start()` under `Promise.allSettled`, not `all`, because tearing down
  mid-flight destroys a gate that has not yet acquired the microphone — the pending `getUserMedia`
  then resolves into a live mic no one holds a reference to. The gate is also born muted, so an
  eager user speaking during attestation cannot commit an utterance against an engine that cannot
  yet transcribe. A `stopped` latch handles a `stop()` that lands mid-startup.
- **Voice needs a secure context for `navigator.mediaDevices` to exist at all.** WKWebView hides the
  property outside one, so a Tauri **dev** build served over `http://localhost` fails before
  `getUserMedia` is even callable. `MediaDevicesUnavailableError`
  ([`src/voice/voice-error.ts`](../../src/voice/voice-error.ts)) exists to turn that into an
  actionable message rather than a bare `TypeError`; packaged builds are unaffected.
- **Native microphone permissions are declared per platform.** `NSMicrophoneUsageDescription` in
  [`src-tauri/Info.plist`](../../src-tauri/Info.plist) (macOS/iOS TCC blocks — and can crash — mic
  access without it) and `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS` plus the microphone feature in
  [`src-tauri/gen/android/app/src/main/AndroidManifest.xml`](../../src-tauri/gen/android/app/src/main/AndroidManifest.xml).
  See [mobile-setup.md](../development/mobile-setup.md) for the wider manifest picture.
- **Keep the voice runtime out of the entry bundle.** `useVoiceSession` dynamically imports the
  session, engine router and chat reply only when the user actually starts voice, because the
  composer that hosts the trigger is always mounted
  ([`src/voice/ui/use-voice-session.ts:89`](../../src/voice/ui/use-voice-session.ts)). The settings
  page is likewise a deliberately cold chunk, declared outside `routeChunkLoaders` so it is lazy but
  never prefetched ([`src/app.tsx:117`](../../src/app.tsx)). A static import of `@/voice/session`
  anywhere in the composer tree undoes both.
- **Read the flag from the database in `start()`, not from a reactive hook.** A hook returns `false`
  until its query resolves, which on a cold start would silently bypass a configured custom provider
  for the hard-wired engine. `use-voice-session.ts` awaits `getSettings` alongside the dynamic
  imports for exactly this reason.
- **Tear the session down when the composer unmounts.** Chat navigation or HMR would otherwise leave
  an orphaned mic, VAD and `AudioContext` bound to the old chat, and starting again elsewhere sends
  one utterance to two chats at once.

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

- [Managed Inference](./managed-inference.md) — the `/tinfoil` pass-through the hosted engine rides
  on, its enclave guard and its metering.
- [Chat Runtime](./chat-runtime.md) — the send path a voice turn reuses.
- [Widgets](../features/widgets.md) — the content-part parser voice strips before synthesis.
- [App Initialization](./app-initialization.md) — where `experimental_feature_voice` is read at boot.
