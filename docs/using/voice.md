# Voice

Voice mode turns the chat composer into a spoken conversation: you talk, Thunderbolt transcribes what you said, sends it as an ordinary chat message, and reads the reply back.

We never store audio in any form, on the device or on the server. Only the transcript of what you said and the assistant's reply are saved, as normal chat messages.

## Start a voice conversation

1. Leave the composer empty. The send button becomes a voice button.
2. Press it and allow microphone access.
3. Speak, then pause. About one and a half seconds of silence ends your turn and sends it.

Two short tones tell you what is happening when you are not watching the screen: a rising pair when the microphone opens, a quieter falling pair when your turn is handed over.

The microphone stays open while the assistant thinks and speaks. Talking over it cancels the reply in progress and starts a new turn from what you just said.

## What a voice turn is

A voice turn is a regular chat turn. It uses the model you have selected, the same tools, the same chat history, and any project instructions or skills that apply. Messages are stored and synced like typed ones, and encrypted if you have end-to-end encryption enabled. What changes is the reply: because it will be read aloud, the model is asked to keep it short and free of Markdown, links and formatting. Citation markers and display equations are skipped. On-screen results such as maps and charts are pointed at instead of read out ("Take a look at the map on screen").

## What leaves your device

One audio clip goes to the speech engine per utterance, sent after you stop talking. There is no continuous microphone stream, and anything recorded while you are silent is never sent.

Transcription and spoken playback do not count against your usage allowance for Thunderbolt-hosted models. The chat reply itself does, if it runs on one of those models.

## Voice engines

By default, speech goes to **Thunderbolt (hosted, private)**, which needs no setup. Audio is processed by Thunderbolt's confidential computing service: a hardware-isolated server the app verifies before it sends any audio, and whose operator cannot read what is processed inside it.

The alternative, **Custom OpenAI-compatible**, is a preview option you configure under **Settings → Voice**. It sends speech to whatever server you point it at, including one on your own machine.

The hosted engine needs the backend configured with a confidential-inference key, set as the `TINFOIL_API_KEY` environment variable. A self-hosted deployment without that key cannot use it: speech requests fail with `503 Tinfoil provider not configured`. Point voice at a speech server of your own instead.

## Use your own speech server

This is a preview feature and is off by default.

1. Turn on **Custom voice provider** under **Settings → Preferences**, in **Preview Features** within the **Help Thunderbolt Improve** section. A **Voice** entry appears in the settings sidebar.
2. In **Settings → Voice**, set **Provider** to **Custom**, the OpenAI-compatible endpoint option.
3. Fill in the base URL, press **Load models** to populate the pickers, then **Test connection**.

| Field     | Notes                                                                  |
| --------- | ---------------------------------------------------------------------- |
| Base URL  | Include the version prefix, for example `http://localhost:8880/v1`     |
| API key   | Optional. Leave blank for local servers that do not require one        |
| STT model | Speech to text. Prefilled with `whisper-large-v3-turbo`                |
| TTS model | Text to speech. Prefilled with `qwen3-tts`                             |
| TTS voice | Prefilled with `aiden`. The picker lists the voices the server reports |

If the server does not list its models, the pickers become plain text fields and you enter the identifiers by hand.

The server has to expose OpenAI-shaped `/v1/audio/transcriptions` and `/v1/audio/speech`, and it has to allow cross-origin browser requests from the address Thunderbolt is served from. That second one is a CORS setting on the speech server, and getting it wrong causes most connection failures.

Browsers also block mixed content, so a Thunderbolt page served over `https` cannot reach a speech server on `http://localhost`. We recommend putting the speech server behind TLS; failing that, use the desktop app.

Servers known to fit this shape include Kokoro-FastAPI, speaches and LocalAI.

Your base URL and API key are stored on that device only. They are not synced to other devices and are not sent to the Thunderbolt backend. Only your audio and your own key reach the server you name. Changes apply to the next voice session, not the one in progress.

## Platform notes and limitations

In a web browser, voice needs `https` (or `localhost`) and microphone permission. A desktop app run from a dev server has no microphone access over plain `http`, though packaged builds are unaffected.

- There is no wake word and no always-on listening. The microphone opens when you start a session and closes when you exit or leave the chat, and only one session runs at a time.
- There is no separate voice language setting, and the assistant's voice is fixed on the hosted engine.
- Background noise can open a turn on its own. A transcript that is nothing but the filler speech recognition emits on near-silence ("Thanks for watching", a bare "you") is dropped rather than sent, so the model never sees it. Real sign-offs like "thanks" and "bye" are kept and answered.
- Since no audio is recorded, there is nothing to export or replay afterwards.

## Troubleshooting

| Message or symptom                        | Fix                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| Microphone isn't available in this window | Open Thunderbolt over `https`, or use the packaged app rather than a dev server        |
| No **Voice** entry in settings            | Turn on **Custom voice provider** under Preferences → Preview Features                 |
| The assistant interrupts itself           | Your speakers are feeding back into the microphone. Use headphones or lower the volume |
| Speech fails on a self-hosted deployment  | The backend has no confidential-inference key. Configure a custom engine               |
