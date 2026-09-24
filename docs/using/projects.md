# Projects

A project is a folder for related chats plus a set of instructions every chat in it follows. Use one when the same context applies to many conversations, so you stop repeating it.

## Project or skill?

A project's instructions are always on for every chat inside it. Guidance you want available on demand belongs in a [skill](./skills.md), which the model loads only when the request calls for it.

## Create a project

**Projects → New project** in the sidebar. Four fields, one of them required.

| Field        | Required | Limit             | What it does                                                    |
| ------------ | -------- | ----------------- | --------------------------------------------------------------- |
| Icon         | No       | Any emoji         | Marks the project in the sidebar and in the header of its chats |
| Name         | Yes      | 100 characters    | How the project is labelled everywhere                          |
| Description  | No       | Any length        | A note for you. It is not sent to the model                     |
| Instructions | No       | 20,000 characters | Applied to every chat in the project                            |

Instructions are plain prose, for example: `Reply in British English. Prefer bullet points over prose.` Edits take effect on the next message, including in chats already open.

## What a chat gets from its project

Every message in a chat carries the project's name and instructions, alongside the rest of the chat's context, once there are instructions to carry. The model can also keyword-search the project's other chats when you refer back to an earlier conversation. Beyond those two things the chats stay separate: nothing from one chat is pasted into another automatically, and the model sees another conversation only if it searches for it.

## Add chats to a project

**Move to project** in a chat's action menu both files a chat and removes it from a project, and on desktop you can drag a chat onto a project row instead. A chat belongs to at most one project.

## Artifacts

Artifacts produced in a project's chats are gathered on the project page, newest first, and selecting one opens the chat that produced it. See [Chat](./chat.md#artifacts).

## Searching across a project's chats

When a chat is in a project, ask something like "what did we decide about pricing?" and the model can look through the project's other conversations for the answer. It is a keyword search: Thunderbolt does not use embeddings or semantic search anywhere, so wording that differs from the original conversation can miss. The model is instructed to retry with synonyms, but we recommend rephrasing the question with the words you originally used.

- The current chat is excluded, since its history is already in view.
- Chats outside the project are never searched.
- Results are excerpts with the source chat named, not whole transcripts.

## Files and documents

A project has no document library. Attachments belong to the chat you add them to and are not shared with the project's other chats. Attachment files stay on the device that added them and do not sync.

## Deleting a project

Deleting a project removes its instructions and the grouping. **Its chats are kept** and become ordinary chats.

## Privacy and sync

Projects sync across devices with the rest of your data, if sync is enabled for the deployment. With end-to-end encryption turned on, a project's name, description, and instructions are encrypted on the device before sync, so the server stores only ciphertext. Projects are included in the account export, and are deleted with the account.

## Limits

Projects are personal to an account, and there is no team or shared project. A project does not carry a model or tool choice either: the model is chosen per chat and tools come from your settings.

- **No per-project knowledge base.** See [Files and documents](#files-and-documents) above.
- **Keyword search only.** See above.
- **External agents receive the project's instructions but cannot search the project's other chats.** An external agent (see [Connections](./connections.md#external-agents)) runs its own tools, and cross-chat search is not among them.
