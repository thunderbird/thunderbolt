/**
 * Creates HTTP Authorization headers for bearer token authentication.
 * Used to inject auth into Streamable HTTP and SSE transport requests.
 */
const createBearerAuthHeaders = (token: string): HeadersInit => ({
  Authorization: `Bearer ${token}`,
})

export { createBearerAuthHeaders }
