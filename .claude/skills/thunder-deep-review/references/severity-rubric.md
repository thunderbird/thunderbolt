# Severity Rubric, Tone & Confidence

Two **independent** axes: **severity** (how much it matters) ⊥ **confidence** (how sure you are). Map them to register; never silently drop a low-confidence item — down-weight it to a question.

## Severity ladder (hand the reader the tier in plain words)

| Tier | When | Signature register | Block? |
|---|---|---|---|
| **Praise** | genuine taste signal | "Nice, very clean", "Good call" | — |
| **Nit** | style/cosmetic | "Nitpick: …", "minor", "this might be nitpicky" | No |
| **Non-blocking idea** | suggestion, no strong opinion | "just an idea", "thinking out loud", "safe to ignore I think?", "ok merging as-is if not trivial" | No |
| **Convention** | house rule, terse | "These should be camelCase", "no `let` here", "use `{ }`" | Soft-firm |
| **Real bug / concern** | genuine correctness | "This is a real bug", "this looks real" | Yes |
| **Future-pain (architectural)** | silent maintainability cost | "this will come back to haunt us", "painful someday", "some future debugger gets burned", "this is a code smell" | Yes (even if nothing breaks today) |
| **Hard block** | won't hold up | "I don't think this approach holds up", "we need these columns nullable" (imperative + *need*) | Yes |

## Confidence → register
- **High** → direct statement + prescribed fix.
- **Medium** → question form ("intended?", "shouldn't we…?", "was this intentional?").
- **Low** → "flagging, no strong feelings — drop if I'm wrong."

## Emission rules
1. Lead with a question or first-person framing; questions do real work (Socratic challenge, info-seek, polite directive, scope/consistency probe).
2. Attach an explicit severity word so the author knows act-now vs later.
3. For non-blockers, grant explicit permission to merge as-is.
4. For out-of-scope concerns, defer with a follow-up rather than block.
5. Distinguish nit from real bug explicitly — never let a cosmetic note and a correctness bug read at the same volume.
6. Convention nits stay terse; may repeat across files (consistency over padding) but count once toward the nit cap.
7. Reserve "haunt us / painful someday / code smell" for **architectural & maintainability** blockers — the strongest non-correctness register; don't spend it on cosmetics.
8. Anti-defensive (let-it-throw) and anti-mocking (DI) are pressed hard even when nothing is broken — the two strongest standing positions.

## High-confidence AI-authored "tells" (pounce on these)
Setter-style reducer actions; `setTimeout`/`rAF` race "fixes"; auto-added obvious comments; `as any`; randomly-generated UUIDs/domains possibly from training data; growing hardcoded enumerations; defensive try/catch swallowing; reinventing an existing primitive.
