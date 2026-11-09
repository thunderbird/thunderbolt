# Chat Sharing

A user can share a chat with specific people by email. What the recipients get is a **frozen, view-only snapshot**: the chat as it was when it was shared, readable only by them, with no way to reply, edit or fork it. The server stores the snapshot as ciphertext under a key it never holds.

A chat has at most one share. Sharing it again replaces that share in place: a new snapshot of the chat as it is now, under a new key, for the people now on the list. A recipient can remove a chat shared with them.

There are no public links and no invites. A recipient must already have an account on the same deployment with sync set up, because sharing seals to a key only such an account has.

## How it works

```
snapshot JSON ──gzip──AES-256-GCM(share key, AAD shareSnapshotAAD)──▶ chat_shares.encrypted_snapshot
title         ────────AES-256-GCM(share key, AAD shareTitleAAD)─────▶ chat_shares.encrypted_title
share key     ──hybrid seal to the recipient's inbox key (AAD shareKeySealAAD)──▶ chat_share_recipients.sealed_share_key
```

1. **Look up.** Each email typed into the share dialog goes to `POST /shares/recipients/check`. The answer is either `ok`, with the recipient's account id and current [inbox key](e2e-encryption.md#the-inbox-key-how-other-accounts-reach-you), or `unavailable`. No account, no sync, an anonymous account, a stale inbox key and yourself all get the same `unavailable`. The answer carries no name, so the lookup says nothing more than "can share" or "cannot".
2. **Seal.** The client builds the snapshot (below), picks a random share key and, for a new share, a share id, encrypts the snapshot and the title under the key, and seals the key once per recipient. The share key is a fresh random key per write attempt: a resealed retry gets a new one too. It is never derived from account keys, never stored by the sharer, and never enters the keyring, the codec or `encodeAAD`.
3. **Store.** `POST /shares/:shareId` stores the ciphertext and one sealed key per recipient, creating the chat's share or replacing it, then emails each recipient the share did not already have (below). It needs a `share` [challenge proof](e2e-encryption.md): sealing takes only public keys, so without one a stolen session could send content of its own in the account's name. A 409 carries a code: `RECIPIENT_CHANGED` when a recipient's inbox key moved on or went away since the lookup, after which the client looks them up again and redoes the write once (`storeWithReseal`, `src/services/shares.ts`); `CHAT_ALREADY_SHARED` when another device shared the chat meanwhile; `SHARE_CHANGED` when a replace names a version (`replacesVersion`) the share no longer has; `SHARE_ID_TAKEN` when the id belongs to another chat. A 404 with `CHAT_NOT_FOUND` means the chat has not synced to the server yet. Refusals commit, so the proof's nonce stays spent.
4. **Open.** A recipient's device fetches the share (`GET /shares/:id`), opens its own inbox key for that version (`openInboxKeys`, `src/services/encryption.ts`), opens the share key, decrypts, and renders the snapshot read-only.

One snapshot serves every recipient: the content is encrypted once and only the 1.6 KB sealed key is per person. Removing a person deletes their row and nothing is re-encrypted. A snapshot never changes until it is replaced, so a removed recipient learns nothing new either way, and anything they already read cannot be taken back.

### Listing

The lists on the Shared page come through PowerSync, not REST. Two read-only synced tables hold them (`backend/src/db/powersync-schema.ts`), each row scoped by `user_id` like every synced table:

- `received_shares`: one row per recipient of a share. It holds the owner's id, name and email, the encrypted title, that recipient's sealed share key and inbox version, and when the share was last replaced.
- `sent_shares`: one row per share, for its owner. It holds the chat id, the recipients as JSON (`ShareUser[]`), the share's `version` and when it was last replaced.

The server is their only writer, and a client upload to either table is accepted and ignored ([powersync-upload-authorization.md](powersync-upload-authorization.md)):

- **Deletes cascade.** Both tables have a foreign key to `chat_shares(id)` with `ON DELETE CASCADE`. Stopping a share, the last person leaving it, deleting its chat or deleting its owner's account removes its synced rows in the same statement, whichever path deleted it.
- **Changes rebuild.** `rebuildShareRows` (`backend/src/dal/shares.ts`) rewrites a share's rows in the transaction that changes who is on it: storing or replacing it, removing a person, a recipient removing it, a recipient's account being deleted.

Names and emails are copied at each rebuild, so a rename shows in the lists on the share's next change, while the opened share always names the owner as they are now. Timestamps are ISO strings the server writes, so the client sorts and parses them as they are.

The rows carry nothing the codec could encrypt: the title is encrypted under the share key, the share key is sealed to the recipient's inbox key, and the rest is account identity the server holds anyway. So the tables are not in `encryptedColumnsMap`. Decrypting a title needs the recipient's inbox seeds from the backend (`GET /encryption/inbox`); when they cannot be loaded, offline or on an error, the list still shows the shares, as untitled. The snapshot is not synced: it can be ~700 KiB per share, and most are never opened, so a device fetches one on open.

`sent_shares` syncs at priority 1, with `chat_threads`, so a device never lists a chat before it knows the chat's share. `received_shares` syncs at priority 2: other accounts decide how many rows it holds, so app start does not wait on it. Writes go over REST while the lists only come through PowerSync, so each write on this device waits until its own change shows in the synced lists before it settles (`src/shared-chats/synced-share-rows.ts`). The lists, and a share dialog opened next, then show the share as it is after the write. The wait is best-effort: it is skipped when PowerSync is not connected, and gives up, with a warning, after ten seconds. A dialog opened before the lists catch up can still show the old share, and saving it is refused as changed elsewhere.

### Sharing again

Opening Share on a chat that is already shared starts from that share as the synced `sent_shares` row lists it, read afresh on each open rather than from a list cached by an earlier one: its people are looked up again, so one who can no longer receive shares shows as unavailable and blocks saving until removed. If that lookup fails, the dialog refuses to edit rather than drop them. Saving sends the version it read (`replacesVersion`, the share's `version`, which every replace bumps). A share edited or stopped on another device since is refused with `SHARE_CHANGED`, so a replace never removes people the user did not see; a synced row that has not caught up with an edit made on another device gets the same refusal. Saving replaces the share in one transaction (`storeShare`, `backend/src/api/shares.ts`), keeping its id so the links in earlier emails still work:

- the snapshot and title are swapped for a new snapshot of the chat as it is now, under a new share key;
- every recipient on the new list gets a new sealed key, and anyone left off it loses their row;
- only people new to the share are emailed, and not again within a day of the last email about that chat (below).

With nobody added or removed, the dialog's button reads **Update to latest**: the same people, the chat as it is now. The sharer holds no share key, so there is no adding a person to the old snapshot; every save is a fresh one for everyone. The write locks the chat's row, so a delete arriving at the same moment waits and then removes the share, and takes each recipient's inbox lock, so the current-version check and the write see the same key.

### AAD

Every share AAD names the share and its owner (`shared/e2ee-types.ts`). The key seal also names the recipient, the inbox version and a SHA-256 of the exact inbox public keys it was sealed to, so a seal cannot be moved to another share, owner, recipient or key. That binding is what the cross-account precondition on `encodeAAD` asks for. The seal is the same hybrid ECDH P-256 + ML-KEM-768 construction as AK envelopes, in its own domain: version byte `0x01`, HKDF info `thunderbolt-share-key-seal-v1` (`src/crypto/share-seal.ts`). The legacy CK envelope also starts with `0x01`; the two stay apart by HKDF info, algorithm and length, so no opener may dispatch on that byte alone.

### The snapshot

`buildShareSnapshot` (`src/shared-chats/snapshot.ts`) is an allowlist. Only what it names is copied, so a new part type or metadata field stays private until someone decides it should be shared.

| Kept                                                                               | Dropped                                                                                       |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| The thread title                                                                   | Every other thread column: agent, project, Mini App, ACP session, model                       |
| User and assistant `text` parts, inline `<widget:…>` tags included                 | System messages, reasoning, quotes                                                            |
| Verified `render_html` artifacts, normalised to `{ html, title }`                  | Every other tool call and its output, unfinished or failed artifacts                          |
| Attachments as `{ filename, mimeType }` — the bytes never left the device          | `localFileId`, delivery modes                                                                 |
| The widget `cache` entries the viewer renders: weather, link previews, Ask answers | `modelId`, `usage`, `mcpTools`, `debugTranscript`, `embeddedSurface`, every other cache entry |
| Citation metadata: `sources`, `haystackReferences`, `haystackDocuments`            |                                                                                               |

The recipient puts the decrypted snapshot back through the same allowlist (`parseShareSnapshot`), since it was written by another account's client.

The snapshot is gzipped before it is encrypted. That tells the server the compressed length, once; a one-off snapshot gives a compression oracle nothing to iterate on.

## Limits

| Limit                | Value                                              | Why                                                                                              |
| -------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Recipients per share | 20 (`maxShareRecipients`)                          | One sealed key each; keeps a share a share rather than a mailing                                 |
| Snapshot ciphertext  | 700 KiB (`maxShareSnapshotBytes`)                  | The whole create request must fit the 1 MiB request-body default of the nginx paths in `deploy/` |
| Snapshot, inflated   | 16 MiB (`maxShareSnapshotJsonBytes`)               | gzip inflates repetitive input about a thousandfold; a recipient stops reading past this         |
| Lookups              | 400 emails per user per hour (`share-lookup` tier) | The lookup reveals which emails can receive shares; charged per email, not per request           |
| Share writes         | 60 per user per hour (`share` tier)                | Each write emails every new recipient                                                            |

Chats over the cap are refused with "too large to share", almost always because of an artifact carrying embedded images.

## Revoking

| Action                 | Effect                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop sharing           | `DELETE /shares/:id` hard-deletes the snapshot and every recipient's sealed key                                                                                                                                                                                                                                                                                                                   |
| Remove one person      | `DELETE /shares/:id/recipients/:userId` deletes their row; removing the last one deletes the share (`removeShareRecipient` locks the share row first, so two removals at once cannot both leave it behind)                                                                                                                                                                                        |
| A recipient removes it | `DELETE /shares/received/:id` deletes the caller's own row; the last one out deletes the share                                                                                                                                                                                                                                                                                                    |
| Delete the chat        | The snapshot read joins the owner's live `chat_threads` row, so the share stops being served as soon as the delete reaches the server; the PowerSync upload that carries it (a PATCH or PUT setting `deleted_at`, or a DELETE) also hard-deletes the share, and its synced rows with it (`backend/src/dal/powersync.ts`). A chat deleted on an offline device is served until that device uploads |
| Delete either account  | Foreign-key cascades remove the owner's shares and their synced rows, or the recipient's rows; `deleteUser` first deletes the shares sent only to the departing account, which the cascade would leave with nobody on them, then rebuilds the owners' synced rows of the shares it was on                                                                                                         |

Each of these updates the share's synced rows in the same transaction, by cascade or by rebuild, so it leaves the lists as the change replicates. Revoking stops future reads. It cannot reach what a recipient already opened, nor the list rows on a device that never reconnects.

A share or person that is already gone answers 404 with the code `SHARE_NOT_FOUND`, told apart from the device gate's 404, which carries none. The client treats a removal that finds nothing to remove as done, since another device got there first, and a viewer that finds the share gone says so.

## The email

`POST /shares/:shareId` emails each new recipient after the share commits, fire-and-forget. Someone emailed about the same chat by the same owner in the last 24 hours is skipped (`claimShareNotifications`, table `chat_share_notifications`), so removing and re-adding a person, or stopping and sharing again, does not mail them each time; deleting the chat clears those rows (`backend/src/lib/share-notifications.tsx`, template `backend/src/emails/chat-shared.tsx`). It names the sharer and links to `/shared/:id`, and nothing else: the title and the content are encrypted. It goes out in the **sharer's** language, because the request carrying `X-App-Language` is the sharer's own; the recipient's language setting is encrypted and unreadable server-side.

## Rendering

The viewer (`/shared/:shareId`, `src/shared-chats/shared-chat-page.tsx`) renders the snapshot with the same `UserMessage` and `AssistantMessage` components a live chat uses, inside a `SharedChatSnapshotProvider` (`src/shared-chats/snapshot-context.tsx`). The snapshot is another account's input, so `parseShareSnapshot` drops any part or citation field not shaped the way the viewer renders it, and each message sits in a `SharedMessageBoundary` that turns a render failure into a one-line note rather than a blank page. The components that would otherwise touch the local database or a chat session check for it:

- `useMessageCache` reads widget data from the snapshot instead of the database, never writes, and never fetches: a widget the snapshot has no data for renders without it, so opening a share sends nothing on the recipient's behalf. The weather widget finds the sharer's entry by location (`snapshotCacheKey`), since its key ends in the viewer's unit and language.
- The Ask widget renders read-only, as the sharer left it.
- The connect-integration widget is hidden: it would act on the recipient's own account.
- Attachments render as name-only chips.
- An artifact opened in the side panel has no conversation to quote into.

Artifacts run in the same sandboxed iframe as everywhere else (`src/components/artifact/`), which matters more here: a shared artifact is HTML another account wrote. A script in it can still navigate its own frame, so it must not be trusted with anything a recipient types into it (C16 residual 9). Images a snapshot names — a link preview's, a source's, one in the text — load from the recipient's device and tell whoever chose them when the chat was opened (residual 10).

## Where things live

| Path                                    | Role                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `shared/chat-shares.ts`                 | Wire contract: DTOs and limits                                                      |
| `shared/e2ee-types.ts`                  | Share AADs, seal version and HKDF info                                              |
| `src/crypto/share-seal.ts`              | Share key, seal/open, gzip + AES-GCM content encryption                             |
| `src/shared-chats/snapshot.ts`          | Snapshot allowlist, parse, conversion to UI messages                                |
| `src/services/shares.ts`                | Share a chat, decrypt received titles, open a received share                        |
| `src/dal/shares.ts`                     | Live queries over the synced share lists                                            |
| `src/shared-chats/synced-share-rows.ts` | Waits for this device's own share writes to reach the synced lists                  |
| `src/api/shares.ts`                     | HTTP calls                                                                          |
| `src/components/share-chat/`            | Share dialog and email tag input, entry from the chat header and the sidebar ⋯ menu |
| `src/shared-chats/`                     | Shared page (Shared with me / Shared by me), viewer, message boundary, hooks        |
| `backend/src/api/shares.ts`             | Routes, recipient checks, emails                                                    |
| `backend/src/dal/shares.ts`             | Queries, the live-chat join, and `rebuildShareRows`                                 |
| `backend/src/db/share-schema.ts`        | `chat_shares`, `chat_share_recipients`, `chat_share_notifications` (not synced)     |
| `backend/src/db/powersync-schema.ts`    | `received_shares`, `sent_shares` (synced, read-only)                                |

## Security

What a share protects and what it does not is claim C16 in the [threat model](e2ee-threat-model.md). In short: a curious server or a database leak reads nothing, and a stolen session cannot send a share in your name; a malicious server, being the directory recipients are looked up in, can substitute keys to read a share and can claim any sender.
