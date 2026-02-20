/**
 * Dynamic system prompt reinforcement for Mistral citation compliance.
 *
 * Mistral's native citation system uses structured ReferenceChunk objects,
 * but through vLLM's OpenAI-compatible API this mechanism is unavailable.
 * The model sometimes falls back to its training (no text-based citations)
 * rather than following prompt instructions.
 *
 * This reinforcement is appended to the system prompt on later steps
 * (after tool calls) via prepareStep's `system` override — the highest
 * authority channel for instruction-tuned models.
 */
export const mistralCitationReinforcement = `

<citation-format>
When writing your response, place [N] after each fact from a tool result.
N = the source number shown in the tool result as [Source N].
Every paragraph must contain at least one [N] reference.
</citation-format>`
