# Models

A Thunderbolt deployment does not ship with a model. Either you set provider keys on the server and pay for the inference yourself, or each user adds their own key in the app. The second route also covers a model server of your own, which may not need a key at all.

## Two ways to provide models

|                               | Deployment-provided                       | Bring your own key                           |
| ----------------------------- | ----------------------------------------- | -------------------------------------------- |
| Who holds the credential      | Your server                               | The user's device                            |
| What the user does            | Nothing, the model works on first sign-in | Adds a provider key in **Settings → Models** |
| Who is billed                 | You, on one provider account              | Each user, on their own account              |
| Spend controls                | Per-account rolling limits you set        | None, Thunderbolt does not meter these       |
| Works without internet access | No                                        | No, unless the model runs locally            |

The two can coexist. Users pick per chat from whatever is available to them.

## When no server keys are set

Neither provider key is set by default, so a deployment is bring-your-own-key only until you set one.

Three deployment-provided models are listed in the app regardless of what you configure, because the list ships with the release. Without the matching server key they appear selectable and fail when a message is sent. No setting hides them, though each user can disable or delete a model in **Settings → Models**. If you do not intend to fund server-side inference, tell your users to add their own key.

## Deployment-provided models

Set these on the API service and restart.

| Variable              | Default                           | Enables                                            |
| --------------------- | --------------------------------- | -------------------------------------------------- |
| `ANTHROPIC_API_KEY`   | none                              | Opus 5, routed to Anthropic through your server    |
| `TINFOIL_API_KEY`     | none                              | GLM 5.3 Flash and GLM 5.3, the confidential models |
| `TINFOIL_ENCLAVE_URL` | `https://inference.tinfoil.sh/v1` | The enclave endpoint. Keep the `/v1` suffix        |

Those keys cover three models. The catalog is fixed by the release you are running.

| Model         | Tier         | Context window   | Notes                                                                                                                                          |
| ------------- | ------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| GLM 5.3 Flash | Confidential | 131,072 tokens   | The default model on a new account. Fastest and cheapest of the three. Accepts image attachments                                               |
| GLM 5.3       | Confidential | 131,072 tokens   | Stronger and slower. Text only, image attachments are dropped before sending                                                                   |
| Opus 5        | Standard     | 1,000,000 tokens | Anthropic's top reasoning model, and the only one of the three where your server sees the full request and response. Accepts image attachments |

Adding a fourth deployment-provided model is a change to the software, not a configuration change. You can still expose any other model to users through their own keys or a custom endpoint.

### Spend limits

Every deployment-provided request is priced and checked against two rolling windows before it reaches a provider. Limits are whole cents of estimated spend, per account.

| Variable                              | Default | Applies to                        |
| ------------------------------------- | ------- | --------------------------------- |
| `INFERENCE_QUOTA_ANONYMOUS_5H_CENTS`  | `10`    | An anonymous session, any 5 hours |
| `INFERENCE_QUOTA_ANONYMOUS_7D_CENTS`  | `60`    | An anonymous session, any 7 days  |
| `INFERENCE_QUOTA_REGISTERED_5H_CENTS` | `1500`  | A signed-in account, any 5 hours  |
| `INFERENCE_QUOTA_REGISTERED_7D_CENTS` | `7500`  | A signed-in account, any 7 days   |

Anonymous sessions get far less because they cost an attacker nothing to create.

Windows roll continuously, with no monthly reset and no top-up. A user over the limit sees "AI usage limit reached" with the window named, and can keep using their own keys and any custom endpoint. The per-token prices used for this accounting are seeded into your database when you run the release's migrations. They approximate provider list prices and are not an invoice, so read your provider's own billing for what you actually owe.

Confidential usage is counted from a receipt the client posts back after it decrypts the response, because your server never sees those token counts. A client that closes mid-answer leaves that spend uncounted, so confidential totals can run low. Your server signs the account, the model and the price, so a client can only under-report its own usage.

Bring-your-own-key and custom-endpoint traffic is never counted.

## Confidential inference

The confidential models run inside a hardware enclave: an isolated, memory-encrypted part of a server that can prove which software it is running and that nobody, not even whoever operates the machine, can read what is inside. Before sending anything, the app checks that proof and then encrypts the request so that only that enclave can open it. Your server relays sealed bytes it cannot read, in either direction.

In the app these models carry a **Private** badge, and a chat that uses one is called a private chat.

A chat started on a confidential model stays confidential. Standard models are greyed out inside it, and the reverse, so a conversation cannot silently change mode mid-thread. Users start a new chat to switch.

Message content is what the enclave path protects, in both directions, from your server, from the operators of the relay, and from the inference provider's own operators. The metadata around it stays visible: your server records the account, the model name, token counts and timing, which reveals who is talking to the model and the fact that the conversation happened.

Voice input and speech output use the same protected path by default, so they need `TINFOIL_API_KEY` too. Without it the built-in voice engine returns an error. Voice requests are never counted against spend limits.

A personal access token cannot reach confidential models. Requests made with one are refused and the user is told to sign in through the app. Set `CONFIDENTIAL_API_KEYS_ENABLED=true` to allow it, only if you have reviewed what that means for your token issuance.

If the enclave cannot be verified, the message fails with an error saying so. There is no fallback to an unprotected path. Without `TINFOIL_API_KEY`, confidential requests are refused with `503 Tinfoil provider not configured`, while a missing `ANTHROPIC_API_KEY` makes the standard tier fail less cleanly, with a generic server error.

## Bring your own key

Users add models in **Settings → Models**.

| Provider   | API key  | Endpoint URL | Catalog fills itself in            |
| ---------- | -------- | ------------ | ---------------------------------- |
| Anthropic  | Required | No           | Yes, once the key is valid         |
| OpenAI     | Required | No           | Yes, once the key is valid         |
| OpenRouter | Required | No           | Yes, once the key is valid         |
| Tinfoil    | Required | No           | Yes, no key needed to list         |
| Custom     | Optional | Required     | Only if the endpoint publishes one |

The key is stored on the device it was typed on and is never synced to other devices, so a user who adds a model on a laptop will be asked for the key again on their phone. It never reaches your database and is not part of any configuration the server publishes.

Requests are relayed by your API service so the browser can reach providers that refuse cross-origin calls. The relay forwards the key untouched, stores nothing, and logs the upstream hostname rather than the URL. It never logs message content.

Desktop and mobile relay through your API service as well. The desktop app shows a **Settings → Preferences → Network → Use Cloud Proxy** switch, but the direct path it would select is behind a build flag that no released build enables, so plan for provider traffic leaving your server rather than user devices. The switch is greyed out in the browser, which has no alternative.

Adding a model requires a successful **Test Connection** first. The only exception is the deployment-provided models, which have nothing for the user to verify.

## A local or self-hosted model server

Anything that speaks the OpenAI API works: Ollama, LM Studio, llama.cpp, vLLM, or an internal gateway. Choose the **Custom** provider and leave the API key blank if the endpoint does not need one. The app appends `/v1` for you when the address does not already end in it, so give it the server root rather than a full request path.

```text
http://localhost:11434/v1   Ollama
http://localhost:1234/v1    LM Studio
```

"Local" means local to the user's device, not to your server.

| Where the model server runs                                                        | Web app                                                                                                     | Desktop app                        |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| On the same machine as the browser (`localhost`, any `127.x.x.x` address, `[::1]`) | Works, called directly from the device                                                                      | Works                              |
| Public address over HTTPS                                                          | Works, relayed by your API service                                                                          | Works                              |
| A private LAN address, or `host.docker.internal`                                   | Blocked. The relay refuses private and internal addresses, and browsers block plain HTTP from an HTTPS page | Works with **Use Cloud Proxy** off |

Anything that is not on the user's own machine is dialled over HTTPS whether or not the user typed `https://`, so an HTTP-only endpoint on a public address will not work.

No server setting points the whole deployment at one OpenAI-compatible endpoint. Each user adds it themselves, or you publish the endpoint on an HTTPS address they can all reach. A LAN-only model server cannot be used from the web app at all, so put it behind HTTPS on a resolvable name, or have the team use the desktop app.

## Verify

The deep health check sends one real chat message to every deployment-provided model, including one sent into the enclave over the protected path. It needs `MONITORING_TOKEN` set.

```bash
curl -H "Authorization: Bearer $MONITORING_TOKEN" https://your-host/v1/health/models
```

`{"status":"ok"}` means every model answered. Otherwise the response is `503` and names each failure:

| Reason           | Meaning                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `not-configured` | No server key for that model's provider                           |
| `missing-price`  | The model has no price entry, so every request will be refused    |
| `timeout`        | No answer within 20 seconds                                       |
| `upstream-error` | The provider rejected the request. Usually a bad or exhausted key |
| `no-text`        | The provider answered but returned nothing usable                 |

## Troubleshooting

| Symptom                                                 | Likely cause                                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A deployment-provided model fails on every message      | The matching server key is unset. Check `ANTHROPIC_API_KEY` and `TINFOIL_API_KEY`, then restart the API                             |
| "AI usage limit reached"                                | A rolling spend window is exhausted. Raise the `INFERENCE_QUOTA_*` value or wait for the window to roll                             |
| A model shows "API key not configured"                  | A bring-your-own-key model with no key on this device. Keys do not sync, so this is expected on a second device                     |
| Test Connection fails with a key set                    | The provider rejected the key, or the address is wrong. Give an OpenAI-compatible server its root address and let the app add `/v1` |
| A custom endpoint works on desktop but not in a browser | It is on a private address or plain HTTP. See the reachability table above                                                          |
| Confidential models erroring after a provider outage    | The app could not verify the enclave. Retry, then check `/v1/health/models`                                                         |

See [Configuration](./configuration.md) for every setting named on this page.
