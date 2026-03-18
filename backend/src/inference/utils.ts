type Message = { role: string; content: unknown }

const privilegedRoles = new Set(['developer', 'system'])

/** Downgrade developer/system roles to user for all messages except the first (the legitimate system prompt). */
export const sanitizeMessageRoles = (messages: Message[]): Message[] =>
  messages.map((msg, i) => (i > 0 && privilegedRoles.has(msg.role) ? { ...msg, role: 'user' } : msg))
