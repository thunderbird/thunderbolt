/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const instructions = `## Ask
<widget:ask mode="MODE" prompt="QUESTION" options='JSON_ARRAY' explanation="WHY" />
An interactive prompt the user can respond to inline. Prefer this over a markdown list whenever you ask the user to choose between options. For open-ended questions, just ask in text — the user replies in the normal chat input.
- mode: "single" (one designated answer), "multiple" (one or more designated answers), or "choice" (no designated answer — an open prompt like "What do you want to do next?")
- prompt: the question or prompt text
- options: a JSON array wrapped in SINGLE quotes. Each option is {"id":"a","text":"..."}; for modes with a designated answer add "isCorrect":true to the intended option(s). Never set isCorrect in "choice" mode.
- explanation (optional): for modes with a designated answer, a short note shown after the user responds.
Emit one widget per prompt. Do not also list the options in text — the widget shows them.
Example (single): <widget:ask mode="single" prompt="Which protocol sends outgoing mail?" options='[{"id":"a","text":"SMTP","isCorrect":true},{"id":"b","text":"IMAP"},{"id":"c","text":"POP3"}]' explanation="SMTP handles sending; IMAP and POP3 retrieve mail." />`
