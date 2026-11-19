Validate the real macOS Tauri app with native Computer use ON. You are the GUI agent;
you cannot run shell here. At each terminal gate, tell me the exact command below to
run in MY terminal and wait for my safe status. Never ask me to paste a key, code,
auth response or raw backend log into chat. Paste clipboard content with Cmd+V into
the app, submit/navigate before capturing, then ask me to clear the clipboard.

Prepared runtime (replace every {{...}} before giving me this prompt):
- Scratch: {{SCRATCH_DIR}}; original revision: {{REVISION}}.
- Skill directory: {{SKILL_DIR}}; backend log: {{BACKEND_LOG}}.
- Test email: {{TEST_EMAIL}}; validation app: {{APP_NAME}} at {{APP_PATH}}.
- Non-loopback provider URL/model: {{PROVIDER_URL}} / {{MODEL_ID}}.
- Key NAME in ~/.argent/secrets.env: {{KEY_NAME}} (never its value).
- Loopback fake: {{LOOPBACK_URL}}; model thunder-validate-fake; reply {{FAKE_REPLY}}.
- Native capabilities / expected routes from CURRENT code: {{ROUTING_EXPECTATIONS}}.
- Scoped acceptance steps / related tickets: {{STEPS}}.
- Evidence destination: {{EVIDENCE_DIR}}.

If native tools are absent, warn immediately: macOS BLOCKED; do not drive a browser
and call it native. Confirm the front window is the unique validation app, not
/Applications/Thunderbolt.app. Have me close the production app first, saving work.
Use native accessibility discovery where available, inspect after each transition,
and keep screenshots free of credentials.

Terminal helper prefix (all paths below are absolute):
`bash "{{SKILL_DIR}}/scripts/desktop-helper.sh"`

1. Sign in with {{TEST_EMAIL}}. After requesting a fresh code, ask me to run:
   `bash "{{SKILL_DIR}}/scripts/desktop-helper.sh" otp --log "{{BACKEND_LOG}}" --email "{{TEST_EMAIL}}"`
   Wait for “copied”, paste with Cmd+V, submit; then ask me to run:
   `bash "{{SKILL_DIR}}/scripts/desktop-helper.sh" clear`
   Complete onboarding if scoped; confirm the app's persisted server is the local backend.
2. Set **Use Cloud Proxy OFF**. If Web Inspector is available, ask me to evaluate
   `await window.__TAURI__.core.invoke('capabilities')` there and report only capabilities.
   Compare native_fetch with prepared routing expectations. Do not assume OFF is direct.
3. Ask me to mark:
   `bash "{{SKILL_DIR}}/scripts/desktop-helper.sh" mark --log "{{BACKEND_LOG}}" desktop-off-before`
4. Add/edit the non-loopback custom OpenAI-compatible provider. For its key ask me to run:
   `bash "{{SKILL_DIR}}/scripts/desktop-helper.sh" key {{KEY_NAME}}`
   Paste, save/navigate, clear clipboard with the helper. Check catalog loading/selection,
   manual **Custom** fallback where applicable, connection test and a successful chat.
   Record each assertion. Within the overall window, create separate nested marks for
   each action (e.g. `desktop-off-catalog-before` / `desktop-off-catalog-after`, then
   `desktop-off-test-*` and `desktop-off-chat-*`); ask me to run the full mark/events
   helper commands for each pair. Wait for completion/network settling before each mark.
5. Ask me to run both commands and return **only** safe event lines:
   `bash "{{SKILL_DIR}}/scripts/desktop-helper.sh" mark --log "{{BACKEND_LOG}}" desktop-off-after`
   `bash "{{SKILL_DIR}}/scripts/desktop-helper.sh" events --log "{{BACKEND_LOG}}" desktop-off-before desktop-off-after`
6. Turn **Use Cloud Proxy ON**, then:
   `bash "{{SKILL_DIR}}/scripts/desktop-helper.sh" mark --log "{{BACKEND_LOG}}" desktop-on-before`
   Repeat catalog/test/chat for the SAME non-loopback target, retaining successful UI
   assertions. Ask me to run:
   `bash "{{SKILL_DIR}}/scripts/desktop-helper.sh" mark --log "{{BACKEND_LOG}}" desktop-on-after`
   `bash "{{SKILL_DIR}}/scripts/desktop-helper.sh" events --log "{{BACKEND_LOG}}" desktop-on-before desktop-on-after`
   Require matching target-host events as the proxy-positive control. Without this,
   zero events under OFF do not establish a direct-routing PASS. Repeat nested per-action
   marks for `desktop-on-catalog-*`, `desktop-on-test-*`, `desktop-on-chat-*`, so each
   individual route claim has its own success and control evidence.
7. Add the loopback fake endpoint {{LOOPBACK_URL}} using a disposable dummy key if needed.
   Verify catalog/test/known reply with ON and OFF, using unique `loopback-on-before`,
   `loopback-on-after`, `loopback-off-before`, `loopback-off-after` marks through the SAME
   mark/events command form above. Ask me for safe fake endpoint hit summaries too.
   Expect success + zero target proxy events only when current code predicts direct.
8. Execute {{STEPS}}, including reload/reopen persistence and relevant negative paths.
   Inspect UI/runtime errors; report `plugin http not found` if it occurs. An absence
   claim needs reviewed console/log evidence from these actions, not a guess.
9. Save safe screenshots/assertions for every PASS and twice reproduce candidate bugs.
   Return check × platform table: expected/observed, PASS/FAIL/BLOCKED, evidence path,
   event marks/control, limitations. Missing inspector/credentials/control blocks only
   the affected claims. Keep the services alive; ask before teardown. Ask me to run:
   `python3 "{{SKILL_DIR}}/scripts/secrets.py" scan "{{EVIDENCE_DIR}}"`
   A scan hit blocks sharing that artifact. Finish with remaining gaps and owned cleanup.
