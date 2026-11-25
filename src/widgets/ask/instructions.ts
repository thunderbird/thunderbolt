/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const instructions = `## Ask
<widget:ask mode="MODE" prompt="QUESTION" options='JSON_ARRAY' explanation="WHY" />
An interactive prompt the user can respond to inline. Prefer this over a markdown list whenever you ask the user to choose between options. For open-ended questions, just ask in text — the user replies in the normal chat input.
- mode: pick by intent.
  - Teaching or testing the user (a quiz, checking what they understood): "single" (one right answer) or "multiple" (several right answers). The user sees right/wrong as soon as they answer.
  - Asking the user to decide or give input (what to do next, preferences, details you need): "choice" (they pick one) or "choices" (they pick one or more). There is no right answer, and the widget also offers "Other…" so the user can type their own — never add an "Other" option yourself.
- prompt: the question or prompt text
- options: a JSON array wrapped in SINGLE quotes. Each option is {"id":"a","text":"..."}; for "single"/"multiple" add "isCorrect":true to the right option(s). Never set isCorrect in "choice" or "choices" mode. Every "single"/"multiple" question must mark its right option(s) with "isCorrect":true; if you cannot say which option is right, use "choice"/"choices" instead.
- explanation (optional, "single"/"multiple" only): shown after the user answers. Add it only when it teaches something beyond which option is right — the right/wrong colours already show that.
- optional (optional): "true" lets the user skip a question they may not want to answer, so it doesn't hold up the others.
Emit one widget per prompt. Do not also list the options in text — the widget shows them.
For a quiz or any series of questions, put all the widgets back to back in one message with no text between them. The user sees them one at a time, and every answer comes back in a single reply after the last one is answered — wait for it before giving feedback or a score.
Example (single): <widget:ask mode="single" prompt="Which protocol sends outgoing mail?" options='[{"id":"a","text":"SMTP","isCorrect":true},{"id":"b","text":"IMAP"},{"id":"c","text":"POP3"}]' explanation="IMAP and POP3 only retrieve mail; sending always goes through SMTP, even from webmail." />
Example (choices): <widget:ask mode="choices" prompt="Which topics should the summary cover?" options='[{"id":"a","text":"Deadlines"},{"id":"b","text":"Decisions"},{"id":"c","text":"Open questions"}]' optional="true" />`
