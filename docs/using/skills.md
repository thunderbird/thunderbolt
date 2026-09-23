# Skills

A skill is a named, reusable block of instructions. Instead of pasting the same brief into chat every time, you save it once and pull it in with `/name`. The assistant can also load a skill on its own when the request matches what the skill is for.

Skills live in **Settings → Skills**. They sync to every device signed in to your account.

## Two ways a skill runs

| How it starts                            | What happens                                        |
| ---------------------------------------- | --------------------------------------------------- |
| You type `/name` in the composer         | Those instructions are attached to that one message |
| The assistant decides it needs the skill | It loads the instructions mid-answer and carries on |

The assistant normally sees only a short list of skill names and descriptions up front. Full instructions are pulled in when a skill is actually used, so a large library does not slow down or inflate every message. Loading a skill unprompted needs a model with tool support; on a model without it the assistant never sees your skills, though typing the token still works.

## Using a skill in chat

Pinned skills appear as chips above the composer, and typing `/` or `@` opens a picker that also lists any commands offered by a connected external agent. A token such as `/daily-brief` works anywhere in a message, as long as it follows a space or starts the line, and you can use more than one skill in a single message.

A recognized token is highlighted in the composer. Click a token that is greyed out to enable the skill it names, or to create a skill under that name if none exists. A token that matches nothing is sent as ordinary text.

## Pinning

Pinning controls the chips above the composer, nothing else. An unpinned skill still works by typing its token, and the assistant can still load it. You can pin up to 10 skills.

Disabling a skill unpins it. Weather ships pinned, but it is a display contract (see below): unpin it and it cannot be pinned again.

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

| Action     | Effect                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Toggle off | The skill stays in your library but is hidden from the assistant and from `/` tokens                                                     |
| Edit       | Changes apply to the next message. Past chats keep the answers they already produced, but regenerating one uses the current instructions |
| Delete     | Removes the skill from your library on every device                                                                                      |

Changing a slug does not rewrite tokens you have already typed into a draft, so update those by hand. If another skill mentions the one you are about to disable or delete, Thunderbolt names the skills that reference it before you confirm.

## What ships by default

Every account starts with nine skills. Five of them are display contracts that tell the assistant how to render a particular kind of answer, such as a weather card or a map.

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
- **Weather**, **Link Preview**, **Map**, **Ask** and **Connect Integration** are display contracts. You can turn them off, but not rename, edit or delete them, because the wording is what makes the matching card render correctly.
- **Daily Brief** assembles forecast, headlines, inbox and calendar, skipping any section it has no data or connection for.
- **Important Emails** ships turned off. Turn it on in Settings → Skills; it needs a connected mail account to return anything.

Search and Research also raise the number of web lookups allowed for the message that uses them.

Editable defaults behave like your own skills once you change them: your edit is kept, and later Thunderbolt releases will not overwrite it.

## Skills and external agents

Skills are not limited to the built-in assistant. When you connect an external agent, Thunderbolt hands it your enabled skills so it can load them the same way. Agents that do not support that are given the instructions directly in the session instead.

## Privacy and portability

| Question                                 | Answer                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where are skills stored                  | In your account, synced to your signed-in devices                                                                                                 |
| Are they encrypted                       | Yes, when end-to-end encryption is enabled for your account, the name, slug, description and instructions are encrypted before leaving the device |
| Are they in my data export               | Yes, **Settings → Preferences → Export My Data** includes every skill                                                                             |
| Does usage analytics see my instructions | No. Skill events carry an anonymized identifier only, never the name or the text                                                                  |

Skills belong to one account. Sharing a skill directly with another user is not supported.

## Finding a skill fast

Press `Cmd/Ctrl+K` and type the skill name. The box also matches text in a skill's description and instructions, so you can find one by what it does.
