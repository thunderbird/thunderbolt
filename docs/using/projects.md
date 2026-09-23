# Projects

A project is a folder for related chats plus a set of instructions every chat in it follows. Use one when the same context applies to many conversations, so you stop repeating it.

## Project or skill?

A project's instructions are always on for every chat inside it. Guidance you want available on demand instead belongs in a [skill](./skills.md), which the model loads only when the request calls for it.

## Create a project

**Projects** in the sidebar opens the project list, and **New project** opens the form.

| Field        | Required | Limit             | What it does                                                    |
| ------------ | -------- | ----------------- | --------------------------------------------------------------- |
| Icon         | No       | Any emoji         | Marks the project in the sidebar and in the header of its chats |
| Name         | Yes      | 100 characters    | How the project is labelled everywhere                          |
| Description  | No       | Any length        | A note for you. It is not sent to the model                     |
| Instructions | No       | 20,000 characters | Applied to every chat in the project                            |

Instructions are plain prose, for example: `Reply in British English. Prefer bullet points over prose.` Edits take effect on the next message, including in chats already open.

## What a chat gets from its project

| It gets                                 | Detail                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| The project's name and instructions     | Sent with every message in that chat, alongside the rest of the chat's context   |
| Search across the project's other chats | The model can keyword-search them when you refer back to an earlier conversation |

Chats stay separate otherwise. Nothing from one chat is pasted into another automatically, and the model sees another conversation only if it searches for it.

## Add chats to a project

**Move to project** in a chat's action menu both adds a chat to a project and removes it from one. On desktop you can also drag a chat onto a project row in the sidebar. A chat belongs to at most one project.

## Artifacts

Artifacts produced in a project's chats are gathered on the project page, newest first, and selecting one opens the chat that produced it. See [Chat](./chat.md#artifacts).

## Searching across a project's chats

When a chat is in a project, the model can look through the project's other conversations to answer questions like "what did we decide about pricing?".

- It is a **keyword** search. Thunderbolt does not use embeddings or semantic search anywhere, so wording that differs from the original conversation can miss. The model is instructed to retry with synonyms, but rephrasing your question with the words you originally used is the reliable fix.
- The current chat is excluded, since its history is already in view.
- Chats outside the project are never searched.
- Results are excerpts with the source chat named, not whole transcripts.

## Files and documents

A project has no document library. Attachments belong to the chat you add them to and are not shared with the project's other chats. Attachment files stay on the device that added them and do not sync.

## Deleting a project

Deleting a project removes its instructions and the grouping. **Its chats are kept** and become ordinary chats.

## Privacy and sync

| Question                          | Answer                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Do projects sync across devices?  | Yes, with the rest of your data, if sync is enabled for the deployment                                                                                              |
| Is the content encrypted?         | With end-to-end encryption turned on, a project's name, description, and instructions are encrypted on the device before sync, so the server stores only ciphertext |
| Are they in an export?            | Yes. Projects are included in the account export                                                                                                                    |
| What happens on account deletion? | Projects are deleted with the account                                                                                                                               |

## Limits

- **No sharing.** Projects are personal to an account. There is no team or shared project.
- **No per-project knowledge base.** See [Files and documents](#files-and-documents) above.
- **No per-project model or tool choice.** The model is chosen per chat and tools come from your settings, not from the project.
- **Keyword search only.** See above.
- **External agents receive the project's instructions but cannot search the project's other chats.** An external agent (see [Connections](./connections.md#external-agents)) runs its own tools, and cross-chat search is not among them.
