# c3-models-providers: models and providers

Target: choosing, switching and configuring models, with real providers.
Risks: a model that does not answer or loses the thread's context, a selection or setting that does not stick, a
broken custom endpoint that hangs the app or is accepted silently.
Start state: fresh user, desktop viewport. The AI is **real**: "Opus 5" (Anthropic), "GLM 5.3 Flash" and "GLM 5.3"
answer for real, so replies vary. Keep prompts short and send at most 12 chat messages in total.
Specs for this mission replay against the same real providers, three times each, and two failures confirm a finding.
A spec may depend on what the model does (it answers, it streams, it stops), never on its exact words.
Out of bounds: skills, projects, account deletion, other settings.
