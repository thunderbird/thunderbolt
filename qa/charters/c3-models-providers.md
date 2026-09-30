# c3-models-providers: models and providers

Goal: choosing, switching and configuring models works with real providers.

Start state: fresh user, desktop viewport. In this charter the AI is **real**: "Opus 5" (Anthropic), "GLM 5.3 Flash"
and "GLM 5.3" answer for real, so replies vary. Keep prompts short and send at most 12 chat messages in total.

1. Model picker: open it, check every model is listed, pick each real model and send one short prompt.
2. Switch the model in the middle of a thread and continue the conversation. Reload and check which model is selected.
3. A multi-turn conversation with "Opus 5": three short turns, stop one reply mid-stream, then send again.
4. Settings → Models: open each model, disable one and check it leaves the picker, enable it again.
5. Add a custom model with an unreachable endpoint (for example `http://localhost:9`): run its connection test if the
   form has one, try to chat with it, then edit and delete it. Also try an empty and a malformed URL.

Specs for this charter are replayed later with the fake AI ("Opus 5" always replies "Hello from the fake provider,
one word at a time."), so a spec must not depend on what a real model says. Write the finding for every bug, but
its spec only reproduces what the fake AI can show.

Out of bounds: skills, projects, account deletion, other settings.
