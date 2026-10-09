# c3-models-providers: models and providers

Goal: choosing, switching and configuring models works with real providers.

Start state: fresh user, desktop viewport. In this charter the AI is **real**: "Opus 5.5" (Anthropic), "DeepSeek V4.1 Flash"
and "GLM 5.3" answer for real, so replies vary. Keep prompts short and send at most 20 chat messages in total. Read
every reply: a model that says it cannot answer is a finding.

1. Model picker: open it and check every model is listed. Then, for each real model, start a new chat with it and
   hold a conversation of three short turns, each building on the earlier ones. On one turn ask for a longer answer,
   stop the reply mid-stream, then send again. Functions: `picker-lists`, `models-reply`, `multi-turn-opus-5-5`,
   `multi-turn-deepseek-v4-1-flash`, `multi-turn-glm-5-3`.
2. Switch the model in the middle of a thread and continue the conversation. Reload and check which model is selected.
   Functions: `switch-mid-thread`, `model-persists`.
3. Settings → Models: open each model, disable one and check it leaves the picker, enable it again.
   Function: `model-disable`.
4. Add a custom model with an unreachable endpoint (for example `http://localhost:9`): run its connection test if the
   form has one, try to chat with it, then edit and delete it. Also try an empty and a malformed URL. An error from
   this model is expected, because you broke its endpoint on purpose. Functions: `custom-model`,
   `custom-model-unreachable`, `custom-model-invalid-url`.

Specs for this charter replay against the same real providers, three times each, and two failures confirm a
finding. A spec may depend on what the model does (it answers, it streams, it stops), never on its exact words.

Out of bounds: skills, projects, account deletion, other settings.
