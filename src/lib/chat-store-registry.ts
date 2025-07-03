import { defaultChatStore, UIMessage } from 'ai'
import { v7 as uuidv7 } from 'uuid'

/*
 * Why a registry of ChatStore instances?
 * -------------------------------------
 * The AI-SDK `defaultChatStore` *can* manage many threads in a single store, so
 * in theory we could keep one global instance.  In Thunderbolt however each
 * thread may require its own bespoke configuration – most importantly a
 * dedicated `fetch` implementation that:
 *   • knows how to persist messages for *that* thread (SaveMessagesFunction)
 *   • can inject the correct model or additional headers per thread
 *   • may have different security requirements (encryption, account context …)
 *
 * If we reused one global store we would need complicated routing logic inside
 * `fetch` to discover which thread the request belongs to and wire up the
 * correct persistence/model behaviour.  By creating *one store per thread* we
 * keep those concerns localized and trivial: the store is born with exactly
 * the right `fetch` and initial messages.
 *
 * The tiny `stores` Map below just makes sure we don't create duplicate stores
 * when React mounts/unmounts the same chat component multiple times –
 * components call `getOrCreateChatStore(id, …)` and always get the same (lazy
 * -created) instance back.
 */
const stores = new Map<string, ReturnType<typeof defaultChatStore>>()

type CreateOptions = {
  initialMessages: UIMessage[]
  fetch: typeof fetch
}

export const getOrCreateChatStore = (id: string, { initialMessages, fetch }: CreateOptions) => {
  if (stores.has(id)) return stores.get(id)!

  const store = defaultChatStore({
    maxSteps: 10,
    api: '/api/chat',
    generateId: uuidv7,
    chats: {
      [id]: {
        messages: initialMessages,
      },
    },
    fetch,
  })

  stores.set(id, store)
  return store
}
