# Skills

A skill is a named, reusable block of instructions. Instead of pasting the same brief into chat every time, you save it once and pull it in with `/name`. Skills live in **Settings → Skills**, stored in your account and synced to every device you sign in on.

## Two ways a skill runs

Type `/name` in the composer and those instructions are attached to that one message. The assistant can also load a skill on its own when a request matches what the skill is for, pulling the instructions in mid-answer and carrying on with the reply.

Up front it normally sees only a short list of skill names and descriptions. Full instructions are pulled in when a skill is used, so a large library does not slow down or inflate every message. Loading a skill unprompted needs a model with tool support; on a model without it the assistant never sees your skills, though typing the token still works.

## Using a skill in chat

Pinned skills appear as chips above the composer, and typing `/` or `@` opens a picker that also lists any commands offered by a connected external agent. A token such as `/daily-brief` works anywhere in a message, as long as it follows a space or starts the line, and one message can carry several of them.

Click a greyed-out token to enable the skill it names, or to create a skill under that name if none exists. A token that matches nothing is sent as ordinary text.

## Pinning

Pinning controls the chips above the composer and has no other effect. An unpinned skill still works when you type its token, and the assistant can still load it. You can pin up to 10 skills, and disabling a skill unpins it.

Weather ships pinned, but as a display contract (see below) it cannot be pinned again once you unpin it.

## Creating a skill

**Settings → Skills → New Skill.** All four fields are required.

| Field        | What it is                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| Name         | The display name, free text, for example `Daily Brief`                                                    |
| Slug         | The token you type in chat, for example `daily-brief`. Auto-filled from the name                          |
| Description  | When to use this skill. This is what the assistant reads when deciding whether to load it, so be specific |
| Instructions | What the assistant should do once the skill is loaded                                                     |

Slug rules follow the [AgentSkills specification](https://agentskills.io/specification#name-field): 1 to 64 characters, lowercase letters, digits and hyphens only, no leading, trailing or doubled hyphen. Slugs must be unique within your account.

Skills can refer to each other by token, so a longer workflow can call out to `/search` or `/weather`.

## Editing, disabling and deleting

Toggling a skill off keeps it in your library but hides it from the assistant and from `/` tokens. An edit applies to your next message; past chats keep the answers they already produced, though regenerating one uses the current instructions. Deleting a skill removes it from your library on every device.

Changing a slug does not rewrite tokens you have already typed into a draft, so update those by hand. If another skill mentions the one you are about to disable or delete, Thunderbolt names the skills that reference it before you confirm.

## What ships by default

Every account starts with nine skills.

| Skill               | On by default | Pinned | You can edit it |
| ------------------- | ------------- | ------ | --------------- |
| Search              | Yes           | 1st    | Yes             |
| Research            | Yes           | 2nd    | Yes             |
| Weather             | Yes           | 3rd    | No              |
| Daily Brief         | Yes           | No     | Yes             |
| Important Emails    | No            | No     | Yes             |
| Link Preview        | Yes           | No     | No              |
| Map                 | Yes           | No     | No              |
| Ask                 | Yes           | No     | No              |
| Connect Integration | Yes           | No     | No              |

- **Search** returns web results as a list of link previews rather than a written answer.
- **Research** runs a multi-source investigation and reports findings with citations.
- **Daily Brief** assembles forecast, headlines, inbox and calendar, skipping any section it has no data or connection for.
- **Important Emails** ships turned off. Turn it on in Settings → Skills; it needs a connected mail account to return anything.

Search and Research also raise the number of web lookups allowed for the message that uses them.

Editable defaults behave like your own skills once you change them: your edit is kept, and we don't overwrite it in a later release.

The other five, Weather, Link Preview, Map, Ask and Connect Integration, are display contracts: wording that tells the assistant how to render a particular kind of answer such as a weather card or a map. You can turn them off, but not rename, edit or delete them, because that wording is what makes the matching card render correctly.

## Skills and external agents

When you connect an external agent, Thunderbolt hands it your enabled skills so it can load them the same way. An agent that does not support that is given the instructions directly in the session instead.

## Privacy and portability

When end-to-end encryption is enabled for your account, a skill's name, slug, description and instructions are encrypted before leaving the device. Skill events sent to usage analytics carry an anonymized identifier, never the name or the text. **Settings → Preferences → Export My Data** includes every skill.

Skills belong to one account. Sharing a skill directly with another user is not supported.

## Finding a skill fast

`Cmd/Ctrl+K` matches a skill's description and instructions as well as its name, so you can find one by what it does rather than what it is called.
